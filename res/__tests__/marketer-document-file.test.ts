const mockPrisma: any = { marketerDocument: { findFirst: jest.fn() } };
jest.mock("../util/prisma", () => mockPrisma);
const mockRead = jest.fn();
jest.mock("../util/kycStorage", () => ({ saveKycFile: jest.fn(), readKycFile: (...a: any[]) => mockRead(...a), deleteKycFile: jest.fn() }));
jest.mock("../Services/SchoolService", () => ({ SchoolService: class {} }));
jest.mock("../Services/EmailService", () => ({}));
jest.mock("../Services/TwoFactorService", () => ({}));
jest.mock("../util/logLoginEvent", () => ({ logLoginEvent: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getMarketerDocumentFile } = require("../controller/public/publicController");

const run = async () => {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), type: jest.fn().mockReturnThis(), send: jest.fn() };
  await getMarketerDocumentFile({ params: { id: "9", documentId: "4" }, user: { id: 1 } }, res, jest.fn());
  return res;
};

beforeEach(() => jest.resetAllMocks());

describe("getMarketerDocumentFile", () => {
  it("sends the stored bytes with their content type", async () => {
    mockPrisma.marketerDocument.findFirst.mockResolvedValue({ path: "r2:kyc/a.jpg" });
    mockRead.mockResolvedValue({ buffer: Buffer.from("img"), contentType: "image/jpeg" });

    const res = await run();

    expect(res.type).toHaveBeenCalledWith("image/jpeg");
    expect(res.send).toHaveBeenCalledWith(Buffer.from("img"));
  });

  it("answers 404 DOCUMENT_FILE_MISSING when the record exists but the file is gone", async () => {
    mockPrisma.marketerDocument.findFirst.mockResolvedValue({ path: "old.jpg" });
    mockRead.mockResolvedValue(null);

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].code).toBe("DOCUMENT_FILE_MISSING");
  });
});

export {};
