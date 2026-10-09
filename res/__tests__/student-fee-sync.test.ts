// A class keeps every fee structure it has ever had. Back-filling invoices for
// all of them billed a student who joined a class at the start of a new session
// for every term of every previous year, all unpaid. The back-fill is now limited
// to the school's current session.
import { syncStudentFeeInvoices } from "../util/studentFeeSync";

jest.mock("../config/logger", () => ({ __esModule: true, default: { error: jest.fn() }, error: jest.fn() }));

const STUDENT = { id: 11, schoolId: 5, classId: 20 };

const makeTx = (opts: { activeSession?: { name: string } | null; structures?: any[]; existing?: Set<number> } = {}) => {
  const { activeSession = { name: "2026/2027" }, structures = [], existing = new Set<number>() } = opts;
  return {
    academicSession: { findFirst: jest.fn().mockResolvedValue(activeSession) },
    feeStructure: { findMany: jest.fn().mockResolvedValue(structures) },
    studentFee: {
      findUnique: jest.fn(async ({ where }: any) =>
        existing.has(where.studentId_feeStructureId.feeStructureId) ? { id: 1 } : null
      ),
      create: jest.fn().mockResolvedValue({}),
    },
  };
};

const structure = (id: number, amounts: number[] = [1000, 500]) => ({
  id,
  items: amounts.map((amount) => ({ amount })),
});

describe("syncStudentFeeInvoices", () => {
  it("only considers fee structures of the active session", async () => {
    const tx = makeTx({ structures: [structure(1)] });

    await syncStudentFeeInvoices(tx, STUDENT);

    expect(tx.academicSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { schoolId: 5, isActive: true } })
    );
    expect(tx.feeStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classId: 20, session: "2026/2027" } })
    );
  });

  it("invoices the total of a structure's items, unpaid", async () => {
    const tx = makeTx({ structures: [structure(1, [1000, 500])] });

    await syncStudentFeeInvoices(tx, STUDENT);

    expect(tx.studentFee.create).toHaveBeenCalledWith({
      data: { schoolId: 5, studentId: 11, feeStructureId: 1, totalFee: 1500, amountPaid: 0, status: "unpaid" },
    });
  });

  it("does not invoice a structure the student already has", async () => {
    const tx = makeTx({ structures: [structure(1), structure(2)], existing: new Set([1]) });

    await syncStudentFeeInvoices(tx, STUDENT);

    expect(tx.studentFee.create).toHaveBeenCalledTimes(1);
    expect(tx.studentFee.create.mock.calls[0][0].data.feeStructureId).toBe(2);
  });

  it("leaves a school with no active session as it was, rather than invoicing nothing", async () => {
    // It cannot be told apart from a school that does not use sessions.
    const tx = makeTx({ activeSession: null, structures: [structure(1)] });

    await syncStudentFeeInvoices(tx, STUDENT);

    expect(tx.feeStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classId: 20 } })
    );
    expect(tx.studentFee.create).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a student with no class", async () => {
    const tx = makeTx({ structures: [structure(1)] });

    await syncStudentFeeInvoices(tx, { ...STUDENT, classId: null });

    expect(tx.feeStructure.findMany).not.toHaveBeenCalled();
  });

  it("never throws: a failed sync must not undo the move it rides along with", async () => {
    const tx = makeTx();
    tx.feeStructure.findMany.mockRejectedValue(new Error("db down"));

    await expect(syncStudentFeeInvoices(tx, STUDENT)).resolves.toBeUndefined();
  });
});
