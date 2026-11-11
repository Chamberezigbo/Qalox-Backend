// Screens branch on the `code` and `details` an error carries — a duplicate
// scheme of work offers "Replace", a submission with missing scores offers
// "Submit anyway" — so the error handler has to deliver them. It once dropped
// both, leaving only a message to display.
jest.mock("../config/logger", () => ({ __esModule: true, default: { error: jest.fn() } }));
const mockCapture = jest.fn().mockResolvedValue("1a2b3c4d-0000-4000-8000-000000000000");
jest.mock("../util/errorTracker", () => ({ captureError: (...args: unknown[]) => mockCapture(...args) }));

import { errorMiddleware } from "../middleware/error";
import { AppError } from "../util/AppError";

const run = async (err: unknown) => {
  const res: any = { headersSent: false };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  await errorMiddleware(err, { method: "POST", url: "/x", requestId: "1a2b3c4d-0000-4000-8000-000000000000" } as any, res, jest.fn());
  return { res, body: res.json.mock.calls[0][0], status: res.status.mock.calls[0][0] };
};

describe("errorMiddleware", () => {
  it("delivers the code and details an AppError carries", async () => {
    const err = Object.assign(new AppError("No scores entered yet for yellow arms.", 409), {
      code: "SUBMISSION_NOT_READY",
      details: { reason: "incomplete", groups: ["yellow arms"] },
    });

    const { status, body } = await run(err);

    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      message: "No scores entered yet for yellow arms.",
      code: "SUBMISSION_NOT_READY",
      details: { reason: "incomplete", groups: ["yellow arms"] },
    });
  });

  it("sends only a message when an AppError has no code, and does not record it", async () => {
    mockCapture.mockClear();
    const { body } = await run(new AppError("Nope", 400));

    expect(body).toEqual({ success: false, message: "Nope" });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("never leaks the code of an unhandled error", async () => {
    // A Prisma failure carries a code like P2002 — an internal detail, not a
    // contract a screen should branch on.
    const { status, body } = await run(Object.assign(new Error("boom"), { code: "P2002", details: { secret: true } }));

    expect(status).toBe(500);
    // A server error is recorded, and the user gets a short reference to quote.
    expect(body).toEqual({ success: false, message: "boom (Ref: 1a2b3c4d)", requestId: "1a2b3c4d-0000-4000-8000-000000000000" });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
