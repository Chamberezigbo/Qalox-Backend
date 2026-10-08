// Screens branch on the `code` and `details` an error carries — a duplicate
// scheme of work offers "Replace", a submission with missing scores offers
// "Submit anyway" — so the error handler has to deliver them. It once dropped
// both, leaving only a message to display.
jest.mock("../config/logger", () => ({ __esModule: true, default: { error: jest.fn() } }));

import { errorMiddleware } from "../middleware/error";
import { AppError } from "../util/AppError";

const run = (err: unknown) => {
  const res: any = { headersSent: false };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  errorMiddleware(err, { method: "POST", url: "/x" } as any, res, jest.fn());
  return { res, body: res.json.mock.calls[0][0], status: res.status.mock.calls[0][0] };
};

describe("errorMiddleware", () => {
  it("delivers the code and details an AppError carries", () => {
    const err = Object.assign(new AppError("No scores entered yet for yellow arms.", 409), {
      code: "SUBMISSION_NOT_READY",
      details: { reason: "incomplete", groups: ["yellow arms"] },
    });

    const { status, body } = run(err);

    expect(status).toBe(409);
    expect(body).toEqual({
      success: false,
      message: "No scores entered yet for yellow arms.",
      code: "SUBMISSION_NOT_READY",
      details: { reason: "incomplete", groups: ["yellow arms"] },
    });
  });

  it("sends only a message when an AppError has no code", () => {
    const { body } = run(new AppError("Nope", 400));

    expect(body).toEqual({ success: false, message: "Nope" });
  });

  it("never leaks the code of an unhandled error", () => {
    // A Prisma failure carries a code like P2002 — an internal detail, not a
    // contract a screen should branch on.
    const { status, body } = run(Object.assign(new Error("boom"), { code: "P2002", details: { secret: true } }));

    expect(status).toBe(500);
    expect(body).toEqual({ success: false, message: "boom" });
  });
});
