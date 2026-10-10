// Marketers' ID documents were saved on the server's own disk, which is wiped on
// every deploy: records stayed "Approved" while the files were gone, and the
// Super Admin viewer showed a broken image. They now go to R2, and old rows that
// still point at a disk file keep working.
import fs from "fs";
import os from "os";
import path from "path";

const mockUpload = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();
jest.mock("../Services/R2Service", () => ({
  uploadObject: (...a: any[]) => mockUpload(...a),
  getObjectBuffer: (...a: any[]) => mockGet(...a),
  deleteObject: (...a: any[]) => mockDelete(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveKycFile, readKycFile, deleteKycFile, contentTypeOf } = require("../util/kycStorage");

beforeEach(() => jest.resetAllMocks());

describe("saveKycFile", () => {
  it("stores in R2 under kyc/ and returns the value to save, never touching disk", async () => {
    mockUpload.mockResolvedValue("kyc/kyc_abc.jpg");

    const stored = await saveKycFile({ buffer: Buffer.from("x"), filename: "kyc_abc.jpg", contentType: "image/jpeg" });

    expect(stored).toBe("r2:kyc/kyc_abc.jpg");
    expect(mockUpload).toHaveBeenCalledWith({ buffer: Buffer.from("x"), key: "kyc/kyc_abc.jpg", contentType: "image/jpeg" });
  });

  it("fails when R2 fails, so no row is saved for a file that was never stored", async () => {
    mockUpload.mockRejectedValue(new Error("R2 down"));
    await expect(saveKycFile({ buffer: Buffer.from("x"), filename: "a.jpg", contentType: "image/jpeg" })).rejects.toThrow("R2 down");
  });
});

describe("readKycFile", () => {
  it("reads an R2 document with the right content type", async () => {
    mockGet.mockResolvedValue(Buffer.from("pdf-bytes"));
    const file = await readKycFile("r2:kyc/kyc_abc.pdf");
    expect(mockGet).toHaveBeenCalledWith("kyc/kyc_abc.pdf");
    expect(file).toEqual({ buffer: Buffer.from("pdf-bytes"), contentType: "application/pdf" });
  });

  it("reports an R2 object that is gone as missing, not as an error", async () => {
    mockGet.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    expect(await readKycFile("r2:kyc/gone.jpg")).toBeNull();
  });

  it("lets a real R2 failure (credentials, network) surface", async () => {
    mockGet.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(readKycFile("r2:kyc/x.jpg")).rejects.toThrow("denied");
  });

  it("reports an old disk-only document that was wiped as missing", async () => {
    expect(await readKycFile("kyc_wiped_by_deploy.jpg")).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("never reads outside its folder, whatever is stored", async () => {
    const outside = path.join(os.tmpdir(), "kyc-secret.txt");
    fs.writeFileSync(outside, "secret");
    try {
      expect(await readKycFile(`../../../../..${outside}`)).toBeNull();
    } finally {
      fs.unlinkSync(outside);
    }
  });
});

describe("deleteKycFile", () => {
  it("removes an R2 object", async () => {
    mockDelete.mockResolvedValue(undefined);
    await deleteKycFile("r2:kyc/a.jpg");
    expect(mockDelete).toHaveBeenCalledWith("kyc/a.jpg");
  });

  it("never throws, even when there is nothing to delete", async () => {
    mockDelete.mockRejectedValue(new Error("x"));
    await expect(deleteKycFile("r2:kyc/a.jpg")).resolves.toBeUndefined();
    await expect(deleteKycFile("no_such_file.jpg")).resolves.toBeUndefined();
    await expect(deleteKycFile(null)).resolves.toBeUndefined();
  });
});

describe("contentTypeOf", () => {
  it.each([["a.jpg", "image/jpeg"], ["a.PNG", "image/png"], ["r2:kyc/a.pdf", "application/pdf"], ["a.bin", "application/octet-stream"]])(
    "%s",
    (name, type) => expect(contentTypeOf(name)).toBe(type)
  );
});

export {};
