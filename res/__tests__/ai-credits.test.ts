// DB-independent checks for AI credit metering. The reserve/true-up/refund
// cycle decides what a school is actually charged, so the arithmetic and the
// refund-on-failure guarantee are worth pinning down.
jest.mock("../util/prisma", () => ({
  school: { findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock("../util/getActivePlanForSchool", () => ({
  getActivePlanForSchool: jest.fn(),
}));

import prisma from "../util/prisma";
import { getActivePlanForSchool } from "../util/getActivePlanForSchool";
import {
  creditsForTokens,
  estimateTokensFromText,
  reserveCredits,
  trueUpCredits,
  refundCredits,
} from "../Services/AiCreditService";

const mockPrisma = prisma as unknown as {
  school: { findUnique: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};
const mockPlan = getActivePlanForSchool as jest.Mock;

/** Runs the callback against a tx object that proxies to the mocked prisma. */
const runTransaction = async (cb: (tx: unknown) => unknown) => cb(mockPrisma);

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(runTransaction);
});

describe("creditsForTokens — cost arithmetic", () => {
  it("prices a typical lesson note at ~2 credits", () => {
    // 1,800 input + 2,048 output tokens on gemini-2.0-flash
    expect(creditsForTokens({ inputTokens: 1800, outputTokens: 2048 })).toBe(2);
  });

  it("prices a 30-question exam set at ~4 credits", () => {
    expect(creditsForTokens({ inputTokens: 1800, outputTokens: 4096 })).toBe(4);
  });

  it("charges output tokens more than input tokens", () => {
    const heavyIn = creditsForTokens({ inputTokens: 10000, outputTokens: 0 });
    const heavyOut = creditsForTokens({ inputTokens: 0, outputTokens: 10000 });
    expect(heavyOut).toBeGreaterThan(heavyIn);
  });

  it("never charges 0 for a call that actually happened", () => {
    expect(creditsForTokens({ inputTokens: 1, outputTokens: 1 })).toBe(1);
  });

  it("estimates tokens from text at roughly 4 characters each", () => {
    expect(estimateTokensFromText("a".repeat(4000))).toBe(1000);
    expect(estimateTokensFromText("")).toBe(0);
  });
});

describe("reserveCredits — pre-flight gate", () => {
  it("charges the reservation when the school can afford it", async () => {
    mockPlan.mockResolvedValue({ aiCreditsPerTerm: 600 });
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: null }) // allowance lookup
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 100 }); // in-transaction read

    const result = await reserveCredits(1, 40);

    expect(result).toEqual({ reserved: 40, remainingAfter: 460 });
    expect(mockPrisma.school.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiCreditsUsedThisTerm: { increment: 40 } },
    });
  });

  it("refuses — and charges nothing — when the balance is too low", async () => {
    mockPlan.mockResolvedValue({ aiCreditsPerTerm: 600 });
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: null })
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 590 });

    await expect(reserveCredits(1, 40)).rejects.toThrow(/Not enough AI credits/);
    expect(mockPrisma.school.update).not.toHaveBeenCalled();
  });

  it("refuses when the plan excludes AI entirely", async () => {
    mockPlan.mockResolvedValue({ aiCreditsPerTerm: null }); // Basic
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: null })
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 0 });

    await expect(reserveCredits(1, 2)).rejects.toThrow(/isn't included on your school's current plan/);
    expect(mockPrisma.school.update).not.toHaveBeenCalled();
  });

  it("lets a Super Admin override beat the plan's allowance", async () => {
    mockPlan.mockResolvedValue({ aiCreditsPerTerm: 0 });
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: 5000 })
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 0 });

    await expect(reserveCredits(1, 100)).resolves.toMatchObject({ reserved: 100 });
  });
});

describe("trueUpCredits — settling against real usage", () => {
  it("refunds the difference when the real call cost less than reserved", async () => {
    // Reserved 10, actually used ~2 credits' worth
    await trueUpCredits(1, 10, { inputTokens: 1800, outputTokens: 2048 });

    expect(mockPrisma.school.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiCreditsUsedThisTerm: { increment: -8 } },
    });
  });

  it("writes nothing when the reservation was exactly right", async () => {
    await trueUpCredits(1, 2, { inputTokens: 1800, outputTokens: 2048 });
    expect(mockPrisma.school.update).not.toHaveBeenCalled();
  });
});

describe("refundCredits — failure path", () => {
  it("hands the whole reservation back", async () => {
    mockPrisma.school.findUnique.mockResolvedValue({ aiCreditsUsedThisTerm: 50 });

    await refundCredits(1, 20);

    expect(mockPrisma.school.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiCreditsUsedThisTerm: 30 },
    });
  });

  it("clamps at zero so a double refund can't gift free credits", async () => {
    mockPrisma.school.findUnique.mockResolvedValue({ aiCreditsUsedThisTerm: 5 });

    await refundCredits(1, 20);

    expect(mockPrisma.school.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiCreditsUsedThisTerm: 0 },
    });
  });
});
