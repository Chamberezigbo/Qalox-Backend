export {};

jest.mock("../util/prisma", () => ({
  academicSession: { findFirst: jest.fn() },
  studentEnrollment: { findMany: jest.fn() },
  student: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  class: { findMany: jest.fn(), findFirst: jest.fn() },
  feeStructure: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  feeStructureItem: { deleteMany: jest.fn() },
  studentFee: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  payment: { count: jest.fn(), deleteMany: jest.fn() },
  parentAlert: { createMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock("../config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../Services/EmailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}), sendBulkEmail: jest.fn() }));
jest.mock("../util/campusBranding", () => ({ resolveBranding: jest.fn().mockResolvedValue({ name: "School", logoUrl: null, brandColor: "#1a237e" }) }));
jest.mock("../controller/public/publicController", () => ({ schoolMediaUrl: jest.fn().mockResolvedValue(null) }));

const prismaMock = require("../util/prisma");
const { categoryFor, classifyStudents } = require("../util/studentAdmission");
const { matchesAudience, studentsToBill } = require("../util/feeInvoices");
const { syncStudentFeeInvoices } = require("../util/studentFeeSync");
const setup = require("../controller/admin/FeeSetupController");
const fees = require("../controller/admin/FeeManagementController");
const { notifyNewFees } = require("../Services/FeeNotifyService");

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const req = (over: any = {}) => ({ schoolId: 1, campusIds: null, query: {}, body: {}, params: {}, ...over });

// Session ids: 5 = last year, 6 = this year (the fee's session).
beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.academicSession.findFirst.mockResolvedValue({ id: 6, name: "2026/2027" });
  prismaMock.studentEnrollment.findMany.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
});

describe("fresh or returning", () => {
  it("the admin's override always wins", () => {
    expect(categoryFor({ override: "fresh", enrolledEarlier: true, ownSessionEarlier: true })).toEqual({ category: "fresh", source: "override" });
    expect(categoryFor({ override: "returning", enrolledEarlier: false, ownSessionEarlier: false })).toEqual({ category: "returning", source: "override" });
  });
  it("returning with an earlier enrollment OR a record from an earlier session; else fresh", () => {
    expect(categoryFor({ override: null, enrolledEarlier: true, ownSessionEarlier: false }).category).toBe("returning");
    expect(categoryFor({ override: null, enrolledEarlier: false, ownSessionEarlier: true }).category).toBe("returning"); // legacy: no history rows
    expect(categoryFor({ override: null, enrolledEarlier: false, ownSessionEarlier: false })).toEqual({ category: "fresh", source: "automatic" });
  });

  it("classifies a class with one history query", async () => {
    prismaMock.studentEnrollment.findMany.mockResolvedValue([{ studentId: 1 }]);
    const out = await classifyStudents(prismaMock, [
      { id: 1, feeCategory: null, academicSessionId: 6 },   // enrolled last year -> returning
      { id: 2, feeCategory: null, academicSessionId: 6 },   // first time -> fresh
      { id: 3, feeCategory: null, academicSessionId: 5 },   // record from last year, no enrollment rows -> returning
      { id: 4, feeCategory: "fresh", academicSessionId: 5 }, // override
    ], 6);
    expect([...out.entries()].map(([id, v]: any) => [id, v.category])).toEqual([[1, "returning"], [2, "fresh"], [3, "returning"], [4, "fresh"]]);
    expect(prismaMock.studentEnrollment.findMany).toHaveBeenCalledTimes(1);
    // The overridden student needs no history lookup.
    expect(prismaMock.studentEnrollment.findMany.mock.calls[0][0].where.studentId.in).toEqual([1, 2, 3]);
  });
});

describe("who a fee bills", () => {
  const students = [
    { id: 1, feeCategory: null, academicSessionId: 5 }, // returning
    { id: 2, feeCategory: null, academicSessionId: 6 }, // fresh
  ];
  it("matches the audience", () => {
    expect(matchesAudience("all", "fresh")).toBe(true);
    expect(matchesAudience("fresh", "fresh")).toBe(true);
    expect(matchesAudience("fresh", "returning")).toBe(false);
  });
  it("bills only returning students for a returning fee, only fresh for a fresh fee, everyone for all", async () => {
    const ids = async (audience: string) => (await studentsToBill(prismaMock, { audience, session: "2026/2027", schoolId: 1 }, students)).billed.map((s: any) => s.id);
    expect(await ids("returning")).toEqual([1]);
    expect(await ids("fresh")).toEqual([2]);
    expect(await ids("all")).toEqual([1, 2]);
  });
  it("reports the split whatever the audience, for the preview", async () => {
    const r = await studentsToBill(prismaMock, { audience: "all", session: "2026/2027", schoolId: 1 }, students);
    expect(r.counts).toEqual({ fresh: 1, returning: 1 });
  });
  it("with an unknown session: everyone for an all-fee, nobody for fresh/returning (never guesses)", async () => {
    prismaMock.academicSession.findFirst.mockResolvedValue(null);
    expect((await studentsToBill(prismaMock, { audience: "all", session: "free text", schoolId: 1 }, students)).billed).toHaveLength(2);
    expect((await studentsToBill(prismaMock, { audience: "fresh", session: "free text", schoolId: 1 }, students)).billed).toHaveLength(0);
  });
});

describe("a student who joins later", () => {
  const structures = [
    { id: 10, session: "2026/2027", audience: "all", items: [{ amount: 5000 }] },
    { id: 11, session: "2026/2027", audience: "returning", items: [{ amount: 100000 }] },
    { id: 12, session: "2026/2027", audience: "fresh", items: [{ amount: 150000 }] },
  ];
  const sync = async (student: any) => {
    prismaMock.feeStructure.findMany.mockResolvedValue(structures);
    prismaMock.student.findUnique.mockResolvedValue(student);
    prismaMock.studentFee.findUnique.mockResolvedValue(null);
    prismaMock.studentFee.create.mockResolvedValue({});
    await syncStudentFeeInvoices(prismaMock, { id: student.id, schoolId: 1, classId: 3 }, { sessionName: "2026/2027" });
    return prismaMock.studentFee.create.mock.calls.map((c: any) => [c[0].data.feeStructureId, c[0].data.totalFee]);
  };
  it("a new student gets the all-fee and the fresh fee", async () => {
    expect(await sync({ id: 9, feeCategory: null, academicSessionId: 6 })).toEqual([[10, 5000], [12, 150000]]);
  });
  it("a returning student gets the all-fee and the returning fee", async () => {
    expect(await sync({ id: 9, feeCategory: null, academicSessionId: 5 })).toEqual([[10, 5000], [11, 100000]]);
  });
  it("an override changes which fee they get", async () => {
    expect(await sync({ id: 9, feeCategory: "returning", academicSessionId: 6 })).toEqual([[10, 5000], [11, 100000]]);
  });
});

describe("saving fees for several classes", () => {
  const body = (over: any = {}) => ({ classIds: [1, 2], term: "First Term", session: "2026/2027", title: "School Fees", audience: "returning", items: [{ name: "Tuition", amount: 100000 }], ...over });
  beforeEach(() => {
    prismaMock.class.findMany.mockResolvedValue([{ id: 1, name: "JSS 1" }, { id: 2, name: "JSS 2" }]);
    prismaMock.feeStructure.findUnique.mockResolvedValue(null);
    prismaMock.feeStructure.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 100 + data.classId, ...data, items: data.items.create }));
    prismaMock.student.findMany.mockResolvedValue([
      { id: 1, feeCategory: null, academicSessionId: 5 },
      { id: 2, feeCategory: null, academicSessionId: 6 },
    ]);
    prismaMock.studentFee.findMany.mockResolvedValue([]);
    prismaMock.studentFee.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 1000 + data.studentId, ...data }));
  });

  it("creates one fee per class and invoices only the matching students", async () => {
    const res = mockRes();
    await fees.upsertFeeStructure(req({ body: body() }), res, jest.fn());
    const out = res.json.mock.calls[0][0].data;
    expect(prismaMock.feeStructure.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.feeStructure.create.mock.calls[0][0].data).toMatchObject({ title: "School Fees", audience: "returning", classId: 1 });
    expect(out.results).toMatchObject([{ className: "JSS 1", studentsInClass: 2, studentsBilled: 1, invoicesCreated: 1 }, { className: "JSS 2", studentsBilled: 1 }]);
    expect(prismaMock.studentFee.create.mock.calls.every((c: any) => c[0].data.studentId === 1)).toBe(true); // only the returning student
  });

  it("refuses a fresh/returning fee for a session that is not on the school's list", async () => {
    prismaMock.academicSession.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await fees.upsertFeeStructure(req({ body: body() }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe("SESSION_NOT_FOUND");
    expect(prismaMock.feeStructure.create).not.toHaveBeenCalled();
  });

  it("validates the audience, the name and a missing class", async () => {
    for (const bad of [{ audience: "nobody" }, { title: "   " }, { title: "x".repeat(101) }, { dueDate: "not a date" }]) {
      const res = mockRes();
      await fees.upsertFeeStructure(req({ body: body(bad) }), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    prismaMock.class.findMany.mockResolvedValue([{ id: 1, name: "JSS 1" }]); // one of two classes is not theirs
    const res = mockRes();
    await fees.upsertFeeStructure(req({ body: body() }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("still accepts the original single-class request", async () => {
    prismaMock.class.findMany.mockResolvedValue([{ id: 1, name: "JSS 1" }]);
    const res = mockRes();
    await fees.upsertFeeStructure(req({ body: { classId: 1, term: "First Term", session: "2026/2027", items: [{ name: "Tuition", amount: 1000 }] } }), res, jest.fn());
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(prismaMock.feeStructure.create.mock.calls[0][0].data).toMatchObject({ title: "School Fees", audience: "all" });
  });

  it("emails and alerts parents only when asked", async () => {
    prismaMock.studentFee.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      { id: 1001, totalFee: 100000, student: { id: 1, name: "Bola", surname: "Ojo", parentId: 7, guardianEmail: "g@x.com", campusId: null }, feeStructure: { title: "School Fees", dueDate: null } },
    ]);
    const quiet = mockRes();
    await fees.upsertFeeStructure(req({ body: body() }), quiet, jest.fn());
    expect(quiet.json.mock.calls[0][0].data.notification).toBeNull();
    expect(prismaMock.parentAlert.createMany).not.toHaveBeenCalled();
  });
});

describe("telling parents", () => {
  it("creates an alert per parent and queues emails, counting those with no email", async () => {
    prismaMock.studentFee.findMany.mockResolvedValue([
      { id: 1, totalFee: 5000, student: { id: 1, name: "Bola", surname: "Ojo", parentId: 7, guardianEmail: "a@x.com", campusId: null }, feeStructure: { title: "PTA Levy", dueDate: new Date("2026-12-01") } },
      { id: 2, totalFee: 5000, student: { id: 2, name: "Chi", surname: "Eze", parentId: null, guardianEmail: null, campusId: null }, feeStructure: { title: "PTA Levy", dueDate: null } },
    ]);
    const summary = await notifyNewFees({ schoolId: 1, studentFeeIds: [1, 2] });
    expect(summary).toEqual({ considered: 2, alerts: 1, emailsQueued: 1, noEmail: 1, skipped: 0 });
    const alert = prismaMock.parentAlert.createMany.mock.calls[0][0].data[0];
    expect(alert).toMatchObject({ parentId: 7, studentId: 1, type: "fee_reminder" });
    expect(alert.message).toContain("PTA Levy for Bola: ₦5,000, due 1 December 2026");
  });
  it("never throws: a failure is reported as nothing sent", async () => {
    prismaMock.studentFee.findMany.mockRejectedValue(new Error("db"));
    await expect(notifyNewFees({ schoolId: 1, studentFeeIds: [1] })).resolves.toMatchObject({ alerts: 0 });
  });
});

describe("preview, delete and override", () => {
  it("previews how many fresh and returning students each class has, and who the fee would bill", async () => {
    prismaMock.class.findMany.mockResolvedValue([{ id: 1, name: "JSS 1" }]);
    prismaMock.student.findMany.mockResolvedValue([
      { id: 1, feeCategory: null, academicSessionId: 5 }, { id: 2, feeCategory: null, academicSessionId: 6 }, { id: 3, feeCategory: null, academicSessionId: 6 },
    ]);
    const res = mockRes();
    await setup.preview(req({ body: { classIds: [1], session: "2026/2027", audience: "fresh" } }), res, jest.fn());
    expect(res.json.mock.calls[0][0].data.totals).toEqual({ students: 3, fresh: 2, returning: 1, billed: 2 });
  });

  it("deletes a fee nobody has paid towards, with its unpaid invoices", async () => {
    prismaMock.feeStructure.findFirst.mockResolvedValue({ id: 5, title: "PTA Levy", class: { name: "JSS 1" } });
    prismaMock.payment.count.mockResolvedValue(0);
    prismaMock.studentFee.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = mockRes();
    await setup.deleteStructure(req({ params: { id: "5" } }), res, jest.fn());
    expect(prismaMock.studentFee.deleteMany).toHaveBeenCalledWith({ where: { feeStructureId: 5 } });
    expect(prismaMock.feeStructure.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(res.json.mock.calls[0][0].data.invoicesRemoved).toBe(2);
  });

  it("refuses to delete a fee once any payment was made, so money is never orphaned", async () => {
    prismaMock.feeStructure.findFirst.mockResolvedValue({ id: 5, title: "School Fees", class: { name: "JSS 1" } });
    prismaMock.payment.count.mockResolvedValue(3);
    const res = mockRes();
    await setup.deleteStructure(req({ params: { id: "5" } }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: "HAS_PAYMENTS" });
    expect(prismaMock.feeStructure.delete).not.toHaveBeenCalled();
    // Only pending/successful payments count; a failed attempt does not block.
    expect(prismaMock.payment.count.mock.calls[0][0].where.status).toEqual({ in: ["pending", "success"] });
  });

  it("sets and clears a student's override, and refuses anything else or another campus's student", async () => {
    prismaMock.student.findFirst.mockResolvedValue({ id: 9 });
    let res = mockRes();
    await setup.setCategory(req({ params: { studentId: "9" }, body: { category: "returning" } }), res, jest.fn());
    expect(prismaMock.student.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { feeCategory: "returning" } });
    res = mockRes();
    await setup.setCategory(req({ params: { studentId: "9" }, body: { category: null } }), res, jest.fn());
    expect(prismaMock.student.update).toHaveBeenLastCalledWith({ where: { id: 9 }, data: { feeCategory: null } });
    res = mockRes();
    await setup.setCategory(req({ params: { studentId: "9" }, body: { category: "maybe" } }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    prismaMock.student.findFirst.mockResolvedValue(null);
    res = mockRes();
    await setup.setCategory(req({ params: { studentId: "9" }, body: { category: "fresh" }, campusIds: [4] }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
