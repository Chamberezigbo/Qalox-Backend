// Money handling: a pack must be granted once, bought only when it is real and
// active, and managed with sane values.
const mockPrisma: any = {
  aiCreditPack: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  school: { findUnique: jest.fn() },
  schoolPayment: { create: jest.fn(), findFirst: jest.fn() },
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/getActivePlanForSchool", () => ({ getActivePlanForSchool: jest.fn() }));
jest.mock("../Services/FlutterwaveService", () => ({ createStandardCheckout: jest.fn() }));
jest.mock("../util/getAiCreditsAllowanceForSchool", () => ({ getAiCreditsStatusForSchool: jest.fn() }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { claimPayment } = require("../util/claimPayment");
const billing = require("../Services/BillingService");
const flutterwave = require("../Services/FlutterwaveService");
const { getActivePlanForSchool } = require("../util/getActivePlanForSchool");
const superBilling = require("../controller/superadmin/BillingController");
const adminBilling = require("../controller/admin/AdminBillingController");

const call = async (handler: any, req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await handler({ schoolId: 7, admin: { id: 1 }, params: {}, body: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

beforeEach(() => jest.resetAllMocks());

describe("claimPayment", () => {
  const tx = (rows: any[]) => ({
    $queryRaw: jest.fn().mockResolvedValue(rows),
    schoolPayment: { update: jest.fn().mockResolvedValue({}) },
  });

  it("claims a pending payment, locking the row first", async () => {
    const t = tx([{ status: "pending" }]);
    expect(await claimPayment(t, 5, { status: "success" })).toBe(true);
    expect(t.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String(t.$queryRaw.mock.calls[0][0].join(" "))).toContain("FOR UPDATE");
    expect(t.schoolPayment.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { status: "success" } });
  });

  it("refuses a payment that is already paid, and writes nothing", async () => {
    const t = tx([{ status: "success" }]);
    expect(await claimPayment(t, 5, { status: "success" })).toBe(false);
    expect(t.schoolPayment.update).not.toHaveBeenCalled();
  });

  it("refuses a payment that does not exist", async () => {
    const t = tx([]);
    expect(await claimPayment(t, 5, {})).toBe(false);
  });
});

describe("initializeCreditPackPayment", () => {
  const school = { id: 7, name: "School", email: "s@x.com", admins: [{ name: "Head", email: "h@x.com" }] };
  const pack = { id: 3, name: "Small", credits: 500, price: 2000, isActive: true };

  beforeEach(() => {
    mockPrisma.school.findUnique.mockResolvedValue(school);
    mockPrisma.aiCreditPack.findUnique.mockResolvedValue(pack);
    (getActivePlanForSchool as jest.Mock).mockResolvedValue({ id: 1 });
    flutterwave.createStandardCheckout.mockResolvedValue({ checkoutUrl: "https://pay" });
    mockPrisma.schoolPayment.create.mockResolvedValue({});
  });

  it("records the credits the pack held when it was bought, without a subscription", async () => {
    const result = await billing.initializeCreditPackPayment({ schoolId: 7, packId: 3 });
    expect(result.success).toBe(true);
    expect(result.data.checkoutUrl).toBe("https://pay");
    expect(mockPrisma.schoolPayment.create.mock.calls[0][0].data).toMatchObject({
      purpose: "credit_pack", creditsGranted: 500, amount: 2000, subscriptionId: null, status: "pending",
    });
  });

  it.each([
    [{ isActive: false }, "PACK_NOT_FOUND"],
    [{ price: 0 }, "INVALID_PACK"],
    [{ credits: 0 }, "INVALID_PACK"],
  ])("refuses an unusable pack %j", async (patch, code) => {
    mockPrisma.aiCreditPack.findUnique.mockResolvedValue({ ...pack, ...patch });
    expect((await billing.initializeCreditPackPayment({ schoolId: 7, packId: 3 })).code).toBe(code);
    expect(flutterwave.createStandardCheckout).not.toHaveBeenCalled();
  });

  it("asks a school with no plan to choose one first", async () => {
    (getActivePlanForSchool as jest.Mock).mockResolvedValue(null);
    const result = await billing.initializeCreditPackPayment({ schoolId: 7, packId: 3 });
    expect(result.code).toBe("NO_ACTIVE_PLAN");
    expect(mockPrisma.schoolPayment.create).not.toHaveBeenCalled();
  });

  it("creates no payment row if Flutterwave fails", async () => {
    flutterwave.createStandardCheckout.mockRejectedValue(new Error("down"));
    await expect(billing.initializeCreditPackPayment({ schoolId: 7, packId: 3 })).rejects.toThrow("down");
    expect(mockPrisma.schoolPayment.create).not.toHaveBeenCalled();
  });
});

describe("Super Admin pack management", () => {
  it("creates a valid pack", async () => {
    mockPrisma.aiCreditPack.create.mockResolvedValue({ id: 1 });
    const { status } = await call(superBilling.createCreditPack, { body: { name: " Small ", credits: 500, price: 2000 } });
    expect(status).toBe(201);
    expect(mockPrisma.aiCreditPack.create.mock.calls[0][0].data).toMatchObject({ name: "Small", credits: 500, price: 2000 });
  });

  it.each([
    [{ name: "", credits: 10, price: 100 }],
    [{ name: "x", credits: 0, price: 100 }],
    [{ name: "x", credits: 1.5, price: 100 }],
    [{ name: "x", credits: 10, price: 0 }],
    [{ name: "x", credits: 10, price: -5 }],
  ])("refuses %j", async (body) => {
    expect((await call(superBilling.createCreditPack, { body })).status).toBe(400);
    expect(mockPrisma.aiCreditPack.create).not.toHaveBeenCalled();
  });

  it("changes only the fields given when editing", async () => {
    mockPrisma.aiCreditPack.findUnique.mockResolvedValue({ id: 3 });
    mockPrisma.aiCreditPack.update.mockResolvedValue({ id: 3 });
    await call(superBilling.updateCreditPack, { params: { id: "3" }, body: { isActive: false } });
    expect(mockPrisma.aiCreditPack.update.mock.calls[0][0].data).toEqual({ isActive: false });
  });
});

describe("a school's own payments", () => {
  it("only finds a payment belonging to the school asking", async () => {
    mockPrisma.schoolPayment.findFirst.mockResolvedValue(null);
    const { status } = await call(adminBilling.getPaymentStatus, { params: { reference: "qalox-9-abc" } });
    expect(status).toBe(404);
    expect(mockPrisma.schoolPayment.findFirst.mock.calls[0][0].where).toEqual({ flwReference: "qalox-9-abc", schoolId: 7 });
  });
});

export {};
