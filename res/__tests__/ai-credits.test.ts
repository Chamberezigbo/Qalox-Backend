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
  it("prices a real lesson note at ~4 credits", () => {
    // Token counts measured from an actual gemini-2.5-flash generation
    // against a school's own scheme of work.
    expect(creditsForTokens({ inputTokens: 349, outputTokens: 658 })).toBe(4);
  });

  it("prices the worst-case reservation for a note at 23 credits", () => {
    // What the controller reserves before the call: the full context window
    // plus prompt scaffold, against the 4,096-token output ceiling. Most of
    // this comes back on true-up.
    expect(creditsForTokens({ inputTokens: 3400, outputTokens: 4096 })).toBe(23);
  });

  it("tracks Gemini 2.5 Flash list pricing", () => {
    // Pins the constants to the published rates ($0.30 input / $2.50 output
    // per 1M). These were silently left on 2.0 Flash's cheaper rates while
    // GEMINI_MODEL was already 2.5 Flash, which under-charged every school by
    // roughly six times on output — so the rate itself is worth asserting.
    expect(creditsForTokens({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(600);
    expect(creditsForTokens({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(5000);
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

  it("refuses when the school has no active plan", async () => {
    // Every paid tier now carries an AI allowance, so a zero allowance means
    // the subscription lapsed or never started, not that a tier excludes AI.
    mockPlan.mockResolvedValue(null);
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: null })
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 0 });

    await expect(reserveCredits(1, 2)).rejects.toThrow(/needs an active subscription/);
    expect(mockPrisma.school.update).not.toHaveBeenCalled();
  });

  it("refuses when a plan has AI switched off explicitly", async () => {
    // Still reachable: the Super Admin plan form's "AI not included" checkbox
    // writes aiCreditsPerTerm: null.
    mockPlan.mockResolvedValue({ aiCreditsPerTerm: null });
    mockPrisma.school.findUnique
      .mockResolvedValueOnce({ aiCreditsOverride: null })
      .mockResolvedValueOnce({ aiCreditsUsedThisTerm: 0 });

    await expect(reserveCredits(1, 2)).rejects.toThrow(/needs an active subscription/);
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
    // The usual shape of a generation: 23 reserved against the output ceiling,
    // a real note settling at 4, so 19 go back.
    await trueUpCredits(1, 23, { inputTokens: 349, outputTokens: 658 });

    expect(mockPrisma.school.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { aiCreditsUsedThisTerm: { increment: -19 } },
    });
  });

  it("writes nothing when the reservation was exactly right", async () => {
    await trueUpCredits(1, 4, { inputTokens: 349, outputTokens: 658 });
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
