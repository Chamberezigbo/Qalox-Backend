// The rules of the Subject Teacher -> Class Teacher -> Admin workflow. Pure
// functions, so every status a user sees and every allowed move is pinned here.
/* eslint-disable @typescript-eslint/no-var-requires */
const rules = require("../util/resultWorkflowRules");

describe("locking", () => {
  it.each([["PENDING", true], ["SUBMITTED", true], ["ACCEPTED", true], ["RETURNED", false], ["REJECTED", false]])(
    "%s locks scores: %s",
    (status, locked) => expect(rules.isLocked(status)).toBe(locked)
  );
});

describe("pickSubmission", () => {
  it("lets the most advanced row decide, so a returned old row never hides an accepted one", () => {
    const rows = [{ status: "RETURNED", id: 1 }, { status: "ACCEPTED", id: 2 }, { status: "SUBMITTED", id: 3 }];
    expect(rules.pickSubmission(rows).id).toBe(2);
    expect(rules.pickSubmission([{ status: "RETURNED", id: 1 }, { status: "SUBMITTED", id: 3 }]).id).toBe(3);
    expect(rules.pickSubmission([])).toBeNull();
  });
});

describe("subjectState", () => {
  const sub = (status: string) => ({ status });
  it.each([
    [{ submission: null, isOwn: false, published: false }, "not_submitted"],
    [{ submission: null, isOwn: true, published: false }, "own"],
    [{ submission: sub("SUBMITTED"), isOwn: false, published: false }, "submitted"],
    [{ submission: sub("ACCEPTED"), isOwn: false, published: false }, "accepted"],
    [{ submission: sub("PENDING"), isOwn: false, published: false }, "accepted"], // legacy
    [{ submission: sub("RETURNED"), isOwn: false, published: false }, "returned"],
    [{ submission: sub("RETURNED"), isOwn: true, published: false }, "returned"],
    [{ submission: sub("SUBMITTED"), isOwn: false, published: true }, "published"],
    [{ submission: null, isOwn: true, published: true }, "published"],
  ])("%j is %s", (input, expected) => expect(rules.subjectState(input)).toBe(expected));
});

describe("reviewActions", () => {
  const base = { autoAccepted: false, compilationStatus: null, published: false };

  it("accepts and returns what is waiting", () => {
    expect(rules.reviewActions({ ...base, status: "SUBMITTED" })).toMatchObject({ accept: true, return: true });
  });

  it("can return something it already accepted, but not accept it twice", () => {
    expect(rules.reviewActions({ ...base, status: "ACCEPTED" })).toMatchObject({ accept: false, return: true });
  });

  it("freezes review while the class is with the admin, and once approved", () => {
    for (const compilationStatus of ["SUBMITTED", "APPROVED"]) {
      for (const status of ["SUBMITTED", "ACCEPTED"]) {
        expect(rules.reviewActions({ ...base, status, compilationStatus })).toMatchObject({ accept: false, return: false });
      }
    }
  });

  it("reopens review once the admin has returned the class", () => {
    expect(rules.reviewActions({ ...base, status: "ACCEPTED", compilationStatus: "RETURNED" })).toMatchObject({ return: true });
  });

  it("does nothing with published, returned, own-subject or legacy rows", () => {
    expect(rules.reviewActions({ ...base, status: "ACCEPTED", published: true })).toMatchObject({ accept: false, return: false });
    expect(rules.reviewActions({ ...base, status: "RETURNED" })).toMatchObject({ accept: false, return: false });
    expect(rules.reviewActions({ ...base, status: "ACCEPTED", autoAccepted: true })).toMatchObject({ accept: false, return: false });
    expect(rules.reviewActions({ ...base, status: "PENDING" })).toMatchObject({ accept: false, return: false });
  });
});

describe("compilationReadiness", () => {
  const subjects = (...states: string[]) => states.map((state, i) => ({ subjectId: i + 1, name: `S${i + 1}`, state }));
  const ready = (over: object = {}) => ({ subjects: subjects("accepted", "own"), incompleteStudents: [], compilationStatus: null, ...over });

  it("is ready, with nothing to acknowledge, when every subject is in and every student scored", () => {
    expect(rules.compilationReadiness(ready())).toMatchObject({ canSubmit: true, needsAcknowledgement: false, missingSubjects: [] });
  });

  it("names missing subjects and asks for an acknowledgement rather than forbidding", () => {
    const r = rules.compilationReadiness(ready({ subjects: subjects("accepted", "submitted", "not_submitted", "returned") }));
    expect(r.canSubmit).toBe(true);
    expect(r.needsAcknowledgement).toBe(true);
    expect(r.missingSubjects.map((s: any) => s.name)).toEqual(["S2", "S3", "S4"]);
  });

  it("asks for an acknowledgement when a student is missing scores", () => {
    const r = rules.compilationReadiness(ready({ incompleteStudents: [{ studentId: 1, name: "A", missingSubjects: ["S1"] }] }));
    expect(r).toMatchObject({ canSubmit: true, needsAcknowledgement: true });
  });

  it("forbids submitting with nothing accepted, with no subjects, or with no grading scheme", () => {
    expect(rules.compilationReadiness(ready({ subjects: subjects("submitted", "not_submitted") })).canSubmit).toBe(false);
    expect(rules.compilationReadiness(ready({ subjects: [] })).canSubmit).toBe(false);
    const noScheme = rules.compilationReadiness(ready({ hasGradingScheme: false }));
    expect(noScheme.canSubmit).toBe(false);
    expect(noScheme.blocker).toContain("grading scheme");
  });

  it("forbids submitting again while with the admin, or after approval", () => {
    expect(rules.compilationReadiness(ready({ compilationStatus: "SUBMITTED" })).canSubmit).toBe(false);
    expect(rules.compilationReadiness(ready({ compilationStatus: "APPROVED" })).canSubmit).toBe(false);
    expect(rules.compilationReadiness(ready({ compilationStatus: "RETURNED" })).canSubmit).toBe(true);
  });
});

describe("adminCanReview", () => {
  it("only reviews a class that was submitted", () => {
    expect(rules.adminCanReview("SUBMITTED")).toBe(true);
    for (const status of ["RETURNED", "APPROVED", null]) expect(rules.adminCanReview(status)).toBe(false);
  });
});

export {};
