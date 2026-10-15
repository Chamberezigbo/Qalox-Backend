// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resumptionDateFor,
  isLastPublishedTerm,
  promotionLabel,
  loadSessionSummary,
} = require("../util/reportCardContext");

const term = (id: number, day: number, resumption: string | null = null) => ({
  id,
  createdAt: new Date(2026, 0, day),
  resumptionDate: resumption ? new Date(`${resumption}T00:00:00.000Z`) : null,
});

describe("resumptionDateFor", () => {
  const terms = [term(1, 1, "2026-01-10"), term(2, 2, "2026-05-04"), term(3, 3, "2026-09-14")];

  it("uses the next term's date inside a session", () => {
    expect(resumptionDateFor(terms, 1, [])).toBe("2026-05-04");
  });

  it("uses the next session's first term after the last term", () => {
    const next = [term(11, 5, "2027-01-11"), term(12, 6, "2027-05-03")];
    expect(resumptionDateFor(terms, 3, next)).toBe("2027-01-11");
  });

  it("is null, not today, when nothing is set", () => {
    expect(resumptionDateFor(terms, 3, [])).toBeNull();
    expect(resumptionDateFor([term(1, 1), term(2, 2)], 1, [])).toBeNull();
  });

  it("orders by createdAt even when the rows arrive jumbled", () => {
    expect(resumptionDateFor([terms[2], terms[0], terms[1]], 1, [])).toBe("2026-05-04");
  });

  it("is null for an unknown term", () => {
    expect(resumptionDateFor(terms, null, [])).toBeNull();
    expect(resumptionDateFor(terms, 99, [])).toBeNull();
  });
});

describe("isLastPublishedTerm", () => {
  const terms = [term(1, 1), term(2, 2), term(3, 3)];

  it("is the last term WITH results, not the last term of the calendar", () => {
    expect(isLastPublishedTerm(terms, [1, 2], 2)).toBe(true);
    expect(isLastPublishedTerm(terms, [1, 2], 1)).toBe(false);
  });

  it("is false when nothing is published or no term is named", () => {
    expect(isLastPublishedTerm(terms, [], 1)).toBe(false);
    expect(isLastPublishedTerm(terms, [1], null)).toBe(false);
  });
});

describe("promotionLabel", () => {
  it("names the destination for promotions", () => {
    expect(promotionLabel("promoted", "SS 1")).toBe("Promoted to SS 1");
    expect(promotionLabel("trial", "SS 1")).toBe("Promoted on trial to SS 1");
    expect(promotionLabel("repeat", "JSS 2")).toBe("To repeat to JSS 2");
  });

  it("does not name a class for graduation, and ignores unknown outcomes", () => {
    expect(promotionLabel("graduated", null)).toBe("Graduated");
    expect(promotionLabel("withdrawn", "X")).toBeNull();
  });
});

describe("loadSessionSummary", () => {
  const sessionTerms = [term(1, 1), term(2, 2)];

  const client = (over: Record<string, unknown> = {}) => ({
    publishedResult: { findMany: jest.fn().mockResolvedValue([{ termId: 1 }, { termId: 2 }]) },
    publishedResultRow: {
      findMany: jest.fn().mockResolvedValue([
        { total: 60, publishedResult: { termId: 1 } },
        { total: 80, publishedResult: { termId: 2 } },
      ]),
    },
    promotionRunItem: { findFirst: jest.fn().mockResolvedValue({ outcome: "promoted", toClassId: 9 }) },
    class: { findFirst: jest.fn().mockResolvedValue({ name: "SS 1", customName: null }) },
    ...over,
  });

  const args = { schoolId: 1, studentId: 5, classId: 3, sessionId: 7, sessionTerms };

  it("returns nothing on a term that is not the closing one", async () => {
    expect(await loadSessionSummary(client(), { ...args, termId: 1 })).toBeNull();
  });

  it("returns the average and where the student went on the closing term", async () => {
    const out = await loadSessionSummary(client(), { ...args, termId: 2 });
    expect(out.sessionAverage).toBe(70);
    expect(out.promotion).toEqual({ outcome: "promoted", toClassName: "SS 1", label: "Promoted to SS 1" });
  });

  it("makes no claim when there is no (non-undone) run", async () => {
    const c = client({ promotionRunItem: { findFirst: jest.fn().mockResolvedValue(null) } });
    const out = await loadSessionSummary(c, { ...args, termId: 2 });
    expect(out.promotion).toBeNull();
    expect(out.sessionAverage).toBe(70);
    expect(c.promotionRunItem.findFirst.mock.calls[0][0].where.run.undoneAt).toBeNull();
  });
});

export {};
