// Credits a school bought must survive the term reset, but credits it SPENT must
// not come back for free. The plan's allowance is spent first, so only usage
// above it came out of purchased credits.
const { purchasedAfterReset } = require("../util/aiCreditsCarryOver");

describe("purchasedAfterReset", () => {
  it("keeps everything bought when the plan's allowance covered the usage", () => {
    expect(purchasedAfterReset({ used: 80, baseAllowance: 100, purchased: 500 })).toBe(500);
  });

  it("spends the allowance first, so only the overage comes off purchased credits", () => {
    // 100 from the plan, then 150 from the bought credits.
    expect(purchasedAfterReset({ used: 250, baseAllowance: 100, purchased: 500 })).toBe(350);
  });

  it("never goes negative", () => {
    expect(purchasedAfterReset({ used: 900, baseAllowance: 100, purchased: 300 })).toBe(0);
  });

  it("counts everything as bought when the plan gives no allowance", () => {
    expect(purchasedAfterReset({ used: 40, baseAllowance: 0, purchased: 100 })).toBe(60);
  });

  it("changes nothing for a school that never bought credits", () => {
    expect(purchasedAfterReset({ used: 70, baseAllowance: 100, purchased: 0 })).toBe(0);
  });

  it("treats missing or bad numbers as zero rather than inventing credits", () => {
    expect(purchasedAfterReset({ used: undefined as any, baseAllowance: null as any, purchased: 50 })).toBe(50);
    expect(purchasedAfterReset({ used: 10, baseAllowance: 0, purchased: NaN as any })).toBe(0);
  });
});

export {};
