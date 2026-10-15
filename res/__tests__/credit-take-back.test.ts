// Taking back credits must never overdraw a school or go below zero, and must
// be recorded with a reason.
const mockPrisma: any = {
  school: { findUnique: jest.fn(), update: jest.fn() },
  schoolPayment: { create: jest.fn() },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
};
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../util/getAiCreditsAllowanceForSchool", () => ({
  getAiCreditsStatusForSchool: jest.fn(),
  getAiCreditsAllowanceForSchool: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { maxTakeBack } = require("../util/creditTakeBack");
const { getAiCreditsAllowanceForSchool } = require("../util/getAiCreditsAllowanceForSchool");
const superBilling = require("../controller/superadmin/BillingController");

const call = async (req: object) => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await superBilling.deductSchoolCredits({ admin: { id: 1 }, params: { schoolId: "9" }, body: {}, ...req }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
};

describe("maxTakeBack", () => {
  it.each([
    // base, purchased, used, expected
    [100, 500, 0, 500],
    [100, 500, 300, 300], // 600 allowed, 300 used: 300 unspent, all of it bought
    [100, 500, 90, 500],
    [100, 500, 600, 0], // fully spent
    [100, 500, 900, 0], // overdrawn already
    [0, 0, 0, 0],
  ])("base %i, bought %i, used %i -> %i", (base, purchased, used, expected) => {
    expect(maxTakeBack({ base, purchased, used })).toBe(expected);
  });
});

describe("deductSchoolCredits", () => {
  const setup = (row: { purchased: number; used: number }, base = 100) => {
    jest.resetAllMocks();
    mockPrisma.school.findUnique.mockResolvedValue({ id: 9, name: "Mercy" });
    (getAiCreditsAllowanceForSchool as jest.Mock).mockResolvedValue(base);
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ aiCreditsPurchased: row.purchased, aiCreditsUsedThisTerm: row.used }]),
      school: { update: jest.fn().mockResolvedValue({ aiCreditsPurchased: row.purchased }) },
      schoolPayment: { create: jest.fn().mockResolvedValue({}) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  };

  it("deducts, locks the row first, and records a negative adjustment", async () => {
    const tx = setup({ purchased: 500, used: 0 });
    tx.school.update.mockResolvedValue({ aiCreditsPurchased: 400 });
    const { status, body } = await call({ body: { credits: 100, reason: "Granted twice by mistake" } });

    expect(status).toBe(201);
    expect(body.data).toMatchObject({ deducted: 100, purchasedBalance: 400 });
    expect(String(tx.$queryRaw.mock.calls[0][0].join(" "))).toContain("FOR UPDATE");
    expect(tx.school.update.mock.calls[0][0].data).toEqual({ aiCreditsPurchased: { decrement: 100 } });
    expect(tx.schoolPayment.create.mock.calls[0][0].data).toMatchObject({
      amount: 0, purpose: "credit_adjustment", creditsGranted: -100, status: "success",
    });
  });

  it("refuses more than the school has left unspent, and changes nothing", async () => {
    const tx = setup({ purchased: 500, used: 450 }); // base 100: 150 unspent
    const { status, body } = await call({ body: { credits: 200, reason: "Mistaken grant" } });

    expect(status).toBe(409);
    expect(body.code).toBe("NOT_ENOUGH_TO_TAKE_BACK");
    expect(body.data.available).toBe(150);
    expect(tx.school.update).not.toHaveBeenCalled();
    expect(tx.schoolPayment.create).not.toHaveBeenCalled();
  });

  it("refuses when nothing has been bought or granted", async () => {
    const tx = setup({ purchased: 0, used: 10 });
    const { status } = await call({ body: { credits: 1, reason: "Mistaken grant" } });
    expect(status).toBe(409);
    expect(tx.school.update).not.toHaveBeenCalled();
  });

  it.each([[0], [-5], [1.5], ["abc"]])("refuses %j credits", async (credits) => {
    setup({ purchased: 500, used: 0 });
    const { status } = await call({ body: { credits, reason: "Mistaken grant" } });
    expect(status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    setup({ purchased: 500, used: 0 });
    expect((await call({ body: { credits: 10 } })).status).toBe(400);
    expect((await call({ body: { credits: 10, reason: "  " } })).status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("404s for a school that does not exist", async () => {
    setup({ purchased: 500, used: 0 });
    mockPrisma.school.findUnique.mockResolvedValue(null);
    expect((await call({ body: { credits: 10, reason: "Mistake" } })).status).toBe(404);
  });
});

export {};
