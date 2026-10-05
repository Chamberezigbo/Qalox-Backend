// Only one active scheme of work may exist per class + subject + term. Several
// teachers share a class, so without this a colleague's upload silently
// shadows another's and it becomes ambiguous which document a generated lesson
// note was grounded in.
//
// The rule is enforced twice — once before the expensive extraction step (so a
// refused upload never spends AI credits reading photos) and once inside the
// write transaction (so an upload that lands during that extraction still
// loses). Both are pinned here.
jest.mock("../util/prisma", () => ({
  schemeOfWork: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  class: { findFirst: jest.fn() },
  subject: { findFirst: jest.fn(), findUnique: jest.fn() },
  academicTerm: { findFirst: jest.fn() },
  staff: { findUnique: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock("../Services/R2Service", () => ({
  uploadObject: jest.fn().mockResolvedValue(undefined),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../Services/DocumentTextExtractionService", () => ({
  textFromPdf: jest.fn().mockResolvedValue("Week 1: Photosynthesis. Week 2: Respiration."),
  textFromImage: jest.fn(),
}));

jest.mock("../Services/AiCreditService", () => ({
  reserveCredits: jest.fn(),
  trueUpCredits: jest.fn(),
  refundCredits: jest.fn(),
  creditsForTokens: jest.fn().mockReturnValue(2),
  TOKENS_PER_IMAGE: 800,
}));

jest.mock("../util/getAiCreditsAllowanceForSchool", () => ({
  getAiCreditsAllowanceForSchool: jest.fn(),
  getAiCreditsStatusForSchool: jest.fn(),
}));

jest.mock("../controller/public/publicController", () => ({
  schoolMediaUrl: jest.fn().mockResolvedValue("https://signed.example/doc.pdf"),
}));

import prisma from "../util/prisma";
import DocumentTextExtractionService from "../Services/DocumentTextExtractionService";
import { createSchemeOfWork } from "../Services/SchemeOfWorkService";

const db = prisma as unknown as {
  schemeOfWork: { findFirst: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  class: { findFirst: jest.Mock };
  subject: { findFirst: jest.Mock; findUnique: jest.Mock };
  academicTerm: { findFirst: jest.Mock };
  staff: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};
const extraction = DocumentTextExtractionService as unknown as { textFromPdf: jest.Mock };

const EXISTING = {
  id: 42,
  title: "SS2 Biology — First Term",
  subjectId: 12,
  uploadedByStaffId: 9,
  createdAt: new Date("2026-09-01T10:00:00Z"),
};

const pdf = () => [
  {
    originalname: "scheme.pdf",
    mimetype: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fake"),
    size: 1024,
  },
];

// uploadedByAdminId is spelled out as undefined rather than omitted: the
// service is plain JS, so TS infers every destructured param as required.
const input = (overrides = {}) => ({
  schoolId: 7,
  classId: 11,
  subjectId: 12,
  academicTermId: 2,
  title: "SS2 Biology — First Term",
  files: pdf(),
  uploadedByAdminId: undefined as number | undefined,
  uploadedByStaffId: 3 as number | undefined,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();

  db.class.findFirst.mockResolvedValue({ id: 11 });
  db.subject.findFirst.mockResolvedValue({ id: 12 });
  db.academicTerm.findFirst.mockResolvedValue({ id: 2 });
  db.subject.findUnique.mockResolvedValue({ name: "Biology" });
  db.staff.findUnique.mockResolvedValue({ firstName: "Ada", lastName: "Obi" });
  extraction.textFromPdf.mockResolvedValue("Week 1: Photosynthesis.");

  // Runs the callback against a tx object that proxies to the mocked prisma.
  db.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  db.schemeOfWork.updateMany.mockResolvedValue({ count: 1 });
  db.schemeOfWork.create.mockResolvedValue({ id: 99, files: [] });
});

describe("createSchemeOfWork — one active document per class + subject + term", () => {
  it("refuses a second upload for the same class, subject and term", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(EXISTING);

    await expect(createSchemeOfWork(input())).rejects.toMatchObject({
      statusCode: 409,
      code: "SCHEME_OF_WORK_EXISTS",
    });

    expect(db.schemeOfWork.create).not.toHaveBeenCalled();
  });

  it("names the existing document and its uploader so the client can offer Replace", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(EXISTING);

    await expect(createSchemeOfWork(input())).rejects.toMatchObject({
      details: {
        existing: { id: 42, title: "SS2 Biology — First Term", uploadedBy: "Ada Obi" },
      },
    });
  });

  it("refuses BEFORE reading the document, so a blocked upload spends no credits", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(EXISTING);

    await expect(createSchemeOfWork(input())).rejects.toThrow();

    // Extraction is the step that can call Gemini Vision and bill the school.
    expect(extraction.textFromPdf).not.toHaveBeenCalled();
  });

  it("allows the upload when nothing active exists for that class, subject and term", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(null);

    await createSchemeOfWork(input());

    expect(db.schemeOfWork.create).toHaveBeenCalledTimes(1);
  });

  it("archives the previous document rather than deleting it when replacing", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(EXISTING);

    await createSchemeOfWork(input({ replaceExisting: true }));

    expect(db.schemeOfWork.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "archived" } })
    );
    expect(db.schemeOfWork.create).toHaveBeenCalledTimes(1);
  });

  it("still refuses when a rival upload lands during extraction", async () => {
    // Nothing active at the early check, but one exists by the time the write
    // transaction opens — the race the in-transaction re-check exists for.
    db.schemeOfWork.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING);

    await expect(createSchemeOfWork(input())).rejects.toMatchObject({
      statusCode: 409,
      code: "SCHEME_OF_WORK_EXISTS",
    });

    expect(db.schemeOfWork.create).not.toHaveBeenCalled();
  });

  it("records a teacher upload against their staff id, not an admin id", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(null);

    await createSchemeOfWork(input({ uploadedByStaffId: 3 }));

    expect(db.schemeOfWork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedByStaffId: 3, uploadedByAdminId: null }),
      })
    );
  });

  it("records an admin upload against their admin id, not a staff id", async () => {
    db.schemeOfWork.findFirst.mockResolvedValue(null);

    await createSchemeOfWork(input({ uploadedByStaffId: undefined, uploadedByAdminId: 5 }));

    expect(db.schemeOfWork.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedByAdminId: 5, uploadedByStaffId: null }),
      })
    );
  });
});
