// Promotion moves students into the NEXT session, which may not be active yet.
// Fees must be billed for that session, not the active one.
const { syncStudentFeeInvoices } = require("../util/studentFeeSync");

const fakeTx = () => {
  const created: any[] = [];
  const tx: any = {
    academicSession: { findFirst: jest.fn().mockResolvedValue({ name: "2026/2027" }) },
    feeStructure: { findMany: jest.fn().mockResolvedValue([{ id: 1, items: [{ amount: 100 }] }]) },
    studentFee: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => created.push(data)),
    },
  };
  return { tx, created };
};

describe("syncStudentFeeInvoices session", () => {
  it("uses the active session by default", async () => {
    const { tx } = fakeTx();
    await syncStudentFeeInvoices(tx, { id: 1, schoolId: 7, classId: 3 });
    expect(tx.feeStructure.findMany.mock.calls[0][0].where).toMatchObject({ classId: 3, session: "2026/2027" });
  });

  it("uses the named session instead, without looking up the active one", async () => {
    const { tx } = fakeTx();
    await syncStudentFeeInvoices(tx, { id: 1, schoolId: 7, classId: 3 }, { sessionName: "2027/2028" });
    expect(tx.feeStructure.findMany.mock.calls[0][0].where).toMatchObject({ session: "2027/2028" });
    expect(tx.academicSession.findFirst).not.toHaveBeenCalled();
  });
});

export {};
