export {};

jest.mock("../util/prisma", () => ({
  schoolFeeSettings: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  schoolBankAccount: { findFirst: jest.fn() },
  school: { findUnique: jest.fn() },
  studentFee: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  payment: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  admin: { findMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock("../config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../Services/FlutterwaveService", () => ({
  createSubaccount: jest.fn(), createStandardCheckout: jest.fn(), verifyTransaction: jest.fn(), verifyByReference: jest.fn(),
}));
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));

const prismaMock = require("../util/prisma");
const flw = require("../Services/FlutterwaveService");
const { createNotification } = require("../util/notify");
const service = require("../Services/InAppFeeService");
const { computeBreakdown, amountProblem, serviceChargeRate } = require("../util/feeCharge");

describe("service charge maths", () => {
  it("adds 2% on top, in whole kobo", () => {
    expect(computeBreakdown(50000, 2)).toEqual({ fee: 50000, serviceCharge: 1000, total: 51000, ratePercent: 2 });
  });
  it("rounds the charge UP to the next kobo, never away", () => {
    expect(computeBreakdown(123.45, 2)).toMatchObject({ serviceCharge: 2.47, total: 125.92 });
    expect(computeBreakdown(0.01, 2)).toMatchObject({ serviceCharge: 0.01 });
  });
  it("never drifts on awkward amounts", () => {
    for (const fee of [0.1 + 0.2, 33333.33, 99999.99, 1.15, 70000.07]) {
      const b = computeBreakdown(fee, 2);
      expect(Math.round(b.total * 100)).toBe(Math.round(b.fee * 100) + Math.round(b.serviceCharge * 100));
    }
  });
  it("uses the school's own rate, else the platform's", () => {
    expect(serviceChargeRate({ serviceChargePercent: 1.5 })).toBe(1.5);
    expect(serviceChargeRate({ serviceChargePercent: null })).toBe(2);
    process.env.FEE_SERVICE_CHARGE_PERCENT = "3";
    expect(serviceChargeRate(null)).toBe(3);
    delete process.env.FEE_SERVICE_CHARGE_PERCENT;
  });
  it("checks the amount against what is owed", () => {
    expect(amountProblem(50, 40000)).toContain("smallest payment");
    expect(amountProblem(500, 400)).toContain("only owe");
    expect(amountProblem(40, 40)).toBeNull(); // a small balance can be cleared in full
    expect(amountProblem(100.123, 500)).toContain("two decimal");
    expect(amountProblem(100, 0)).toContain("already fully paid");
  });
});

const IN_APP = { schoolId: 1, mode: "in_app", flwSubaccountId: "RS_ABC", settlementBankAccountId: 9, serviceChargePercent: null };
const FEE = { id: 7, studentId: 3, schoolId: 1, totalFee: 100000, amountPaid: 20000, student: { name: "Bola", surname: "Ojo", guardianEmail: "g@x.com" }, feeStructure: { term: "First Term", session: "2026/2027" } };
const payer = { type: "parent", id: 5, name: "Mrs Ojo", email: "p@x.com", phone: "0800" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SCHOOL_PORTAL_URL = "https://app.example.com";
  prismaMock.schoolFeeSettings.findUnique.mockResolvedValue(IN_APP);
  prismaMock.studentFee.findFirst.mockResolvedValue(FEE);
  prismaMock.payment.count.mockResolvedValue(0);
  prismaMock.payment.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 11, ...data }));
  flw.createStandardCheckout.mockResolvedValue({ checkoutUrl: "https://checkout.example/abc" });
});

describe("startPayment", () => {
  const start = (over: any = {}) => service.startPayment({ schoolId: 1, studentFeeId: 7, studentId: 3, amount: 50000, area: "parent", payer, ...over });

  it("charges fee + 2% and sends the school exactly the fee", async () => {
    const result = await start();
    expect(result.breakdown).toMatchObject({ fee: 50000, serviceCharge: 1000, total: 51000 });
    const checkout = flw.createStandardCheckout.mock.calls[0][0];
    expect(checkout.amount).toBe(51000);
    expect(checkout.subaccounts).toEqual([{ id: "RS_ABC", transaction_charge_type: "flat_subaccount", transaction_charge: 50000 }]);
    expect(checkout.reference).toMatch(/^FEE-7-[0-9a-f]{12}$/);
    expect(checkout.redirectUrl).toBe(`https://app.example.com/parent/fees/payment-result?ref=${checkout.reference}`);
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({
      studentFeeId: 7, amount: 50000, serviceCharge: 1000, chargedAmount: 51000, channel: "in_app", status: "pending", payerType: "parent", payerId: 5,
    });
  });

  it("refuses a school that is not set up for in-app payments", async () => {
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue({ mode: "direct" });
    await expect(start()).rejects.toMatchObject({ statusCode: 409 });
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue({ mode: "in_app", flwSubaccountId: null });
    await expect(start()).rejects.toMatchObject({ statusCode: 409 });
    expect(flw.createStandardCheckout).not.toHaveBeenCalled();
  });

  it("refuses someone else's invoice, and more than is owed", async () => {
    prismaMock.studentFee.findFirst.mockResolvedValue(null);
    await expect(start()).rejects.toMatchObject({ statusCode: 404 });
    prismaMock.studentFee.findFirst.mockResolvedValue(FEE);
    await expect(start({ amount: 80001 })).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it("marks the payment failed when the checkout cannot be created", async () => {
    flw.createStandardCheckout.mockRejectedValue(new Error("down"));
    await expect(start()).rejects.toMatchObject({ statusCode: 502 });
    expect(prismaMock.payment.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { status: "failed", rejectionReason: "Could not start checkout" } });
  });
});

// A transaction client whose raw queries answer the payment lock and then the invoice lock.
const txFor = (paymentStatus: string, fee = { totalFee: 100000, amountPaid: 20000 }) => ({
  $queryRaw: jest.fn().mockResolvedValueOnce([{ status: paymentStatus }]).mockResolvedValueOnce([fee]),
  payment: { update: jest.fn() },
  studentFee: { update: jest.fn() },
});
const PENDING = { id: 11, studentFeeId: 7, amount: 50000, chargedAmount: 51000, receiptNo: "RCP-1", channel: "in_app", status: "pending", flwReference: "FEE-7-abc", payerType: "parent", studentFee: { schoolId: 1, studentId: 3 } };

describe("fulfil", () => {
  const verified = (over: any = {}) => ({ id: 555, tx_ref: "FEE-7-abc", status: "successful", amount: 51000, currency: "NGN", ...over });
  beforeEach(() => {
    prismaMock.payment.findUnique.mockResolvedValue(PENDING);
    prismaMock.studentFee.findUnique.mockResolvedValue({ schoolId: 1, studentId: 3, student: { name: "Bola", surname: "Ojo" } });
    prismaMock.admin.findMany.mockResolvedValue([{ id: 1 }]);
  });

  it("credits the invoice once Flutterwave confirms, and tells the school", async () => {
    flw.verifyTransaction.mockResolvedValue(verified());
    const tx = txFor("pending");
    prismaMock.$transaction.mockImplementation((fn: any) => fn(tx));
    const out = await service.fulfil("FEE-7-abc", { transactionId: 555 });
    expect(out.status).toBe("success");
    expect(tx.payment.update.mock.calls[0][0].data).toMatchObject({ status: "success", flwTransactionId: "555" });
    expect(tx.studentFee.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { amountPaid: 70000, status: "partial" } });
    expect(createNotification).toHaveBeenCalled();
  });

  it("marks the invoice paid when the balance is cleared", async () => {
    flw.verifyTransaction.mockResolvedValue(verified({ amount: 81000 }));
    prismaMock.payment.findUnique.mockResolvedValue({ ...PENDING, amount: 80000, chargedAmount: 81600 });
    flw.verifyTransaction.mockResolvedValue(verified({ amount: 81600 }));
    const tx = txFor("pending");
    prismaMock.$transaction.mockImplementation((fn: any) => fn(tx));
    await service.fulfil("FEE-7-abc", { transactionId: 555 });
    expect(tx.studentFee.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { amountPaid: 100000, status: "paid" } });
  });

  it("a duplicate delivery credits nothing and notifies nobody", async () => {
    flw.verifyTransaction.mockResolvedValue(verified());
    const tx = txFor("success");
    prismaMock.$transaction.mockImplementation((fn: any) => fn(tx));
    const out = await service.fulfil("FEE-7-abc", { transactionId: 555 });
    expect(out.status).toBe("success");
    expect(tx.studentFee.update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("does nothing for a payment already credited", async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ ...PENDING, status: "success" });
    expect((await service.fulfil("FEE-7-abc")).status).toBe("success");
    expect(flw.verifyByReference).not.toHaveBeenCalled();
  });

  it("refuses an amount that does not match, a wrong currency, and a reference mismatch", async () => {
    prismaMock.$transaction.mockImplementation(() => { throw new Error("must not credit"); });
    flw.verifyByReference.mockResolvedValue(verified({ amount: 40000 }));
    expect((await service.fulfil("FEE-7-abc")).status).toBe("failed");
    flw.verifyByReference.mockResolvedValue(verified({ currency: "USD" }));
    expect((await service.fulfil("FEE-7-abc")).status).toBe("failed");
    flw.verifyByReference.mockResolvedValue(verified({ tx_ref: "FEE-9-other" }));
    expect((await service.fulfil("FEE-7-abc")).status).toBe("pending");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("stays pending when Flutterwave cannot be reached or does not know the payment yet", async () => {
    flw.verifyByReference.mockRejectedValue(new Error("network"));
    expect((await service.fulfil("FEE-7-abc")).status).toBe("pending");
    flw.verifyByReference.mockResolvedValue(null);
    expect((await service.fulfil("FEE-7-abc")).status).toBe("pending");
  });

  it("closes a payment Flutterwave says failed, and ignores unknown or non in-app references", async () => {
    flw.verifyByReference.mockResolvedValue(verified({ status: "failed" }));
    expect((await service.fulfil("FEE-7-abc")).status).toBe("failed");
    expect(prismaMock.payment.updateMany).toHaveBeenCalled();
    prismaMock.payment.findUnique.mockResolvedValue(null);
    expect((await service.fulfil("FEE-0-none")).status).toBe("unknown");
    prismaMock.payment.findUnique.mockResolvedValue({ ...PENDING, channel: "bank_transfer" });
    expect((await service.fulfil("FEE-7-abc")).status).toBe("unknown");
  });
});

describe("setCollection and the settlement account", () => {
  it("needs a bank account that was saved with its bank", async () => {
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue(null);
    prismaMock.schoolBankAccount.findFirst.mockResolvedValue({ id: 9, bankCode: null, accountNumber: "0123456789", accountName: "X" });
    await expect(service.setCollection({ schoolId: 1, mode: "in_app", settlementBankAccountId: 9 })).rejects.toMatchObject({ statusCode: 400 });
    // No account chosen and none saved: a clear 400, not "account 0 not found".
    prismaMock.schoolBankAccount.findFirst.mockResolvedValue(null);
    await expect(service.setCollection({ schoolId: 1, mode: "in_app" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.setCollection({ schoolId: 1, mode: "weird" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates the subaccount from the chosen account, and reuses it for the same account", async () => {
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValueOnce(null);
    prismaMock.schoolBankAccount.findFirst.mockResolvedValue({ id: 9, bankCode: "044", accountNumber: "0123456789", accountName: "School Ltd", bankName: "Access" });
    prismaMock.school.findUnique.mockResolvedValue({ name: "Daniel's College", email: "s@x.com", phoneNumber: "080" });
    flw.createSubaccount.mockResolvedValue({ subaccountId: "RS_NEW" });
    await service.setCollection({ schoolId: 1, mode: "in_app", settlementBankAccountId: 9 });
    expect(flw.createSubaccount).toHaveBeenCalledWith({ bankCode: "044", accountNumber: "0123456789", businessName: "Daniel's College", email: "s@x.com", phoneNumber: "080" });
    expect(prismaMock.schoolFeeSettings.upsert.mock.calls[0][0].create).toMatchObject({ mode: "in_app", flwSubaccountId: "RS_NEW", settlementBankAccountId: 9 });

    flw.createSubaccount.mockClear();
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue({ ...IN_APP, settlementBankAccountId: 9, flwSubaccountId: "RS_NEW" });
    await service.setCollection({ schoolId: 1, mode: "in_app", settlementBankAccountId: 9 });
    expect(flw.createSubaccount).not.toHaveBeenCalled();
  });

  it("reports a partner failure plainly and does not switch on", async () => {
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue(null);
    prismaMock.schoolBankAccount.findFirst.mockResolvedValue({ id: 9, bankCode: "044", accountNumber: "0123456789", accountName: "X" });
    prismaMock.school.findUnique.mockResolvedValue({ name: "S" });
    flw.createSubaccount.mockRejectedValue(new Error("Invalid account"));
    await expect(service.setCollection({ schoolId: 1, mode: "in_app", settlementBankAccountId: 9 })).rejects.toMatchObject({ statusCode: 502 });
    expect(prismaMock.schoolFeeSettings.upsert).not.toHaveBeenCalled();
  });

  it("switches back to direct when the payout account changes, so money never goes to the old account", async () => {
    prismaMock.schoolFeeSettings.findUnique.mockResolvedValue({ ...IN_APP });
    expect(await service.settlementAccountChanged(1, 9)).toBe(true);
    expect(prismaMock.schoolFeeSettings.update).toHaveBeenCalledWith({ where: { schoolId: 1 }, data: { mode: "direct", flwSubaccountId: null, settlementBankAccountId: null } });
    prismaMock.schoolFeeSettings.update.mockClear();
    expect(await service.settlementAccountChanged(1, 42)).toBe(false); // a different account: nothing happens
    expect(prismaMock.schoolFeeSettings.update).not.toHaveBeenCalled();
  });
});
