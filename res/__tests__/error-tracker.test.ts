jest.mock("../util/prisma", () => ({
  errorLog: { create: jest.fn(), deleteMany: jest.fn() },
}));
jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const prismaMock = require("../util/prisma");
const tracker = require("../util/errorTracker");
const requestContext = require("../util/requestContext");
const { redact } = jest.requireActual("../config/logger");

const errorAt = (msg: string) => {
  const e = new Error(msg);
  e.stack = `Error: ${msg}\n    at doThing (/app/res/Services/FooService.js:10:5)\n    at node_modules/express/router.js:1:1`;
  return e;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("fingerprint", () => {
  it("groups the same bug even when ids and values differ", () => {
    expect(tracker.fingerprint(errorAt('Student 12 not found in "JSS 1"'))).toBe(
      tracker.fingerprint(errorAt('Student 987 not found in "SS 3"')),
    );
  });
  it("separates different bugs", () => {
    expect(tracker.fingerprint(errorAt("Cannot read properties of undefined"))).not.toBe(
      tracker.fingerprint(errorAt("Connection refused")),
    );
  });
  it("uses our own code frame, not node_modules", () => {
    expect(tracker.firstAppFrame(errorAt("x").stack)).toBe("res/Services/FooService.js");
  });
});

describe("captureError", () => {
  it("saves who, where and which request", async () => {
    const req: any = {
      method: "POST", originalUrl: "/api/admin/classes/5/students/0f8fad5b-d9cb-469f-a165-70867728950e?x=1",
      headers: { "user-agent": "jest" }, schoolId: 7, staffId: 3, requestId: "req-abc",
    };
    const id = await tracker.captureError(errorAt("Unique failure one"), { req, statusCode: 500 });
    expect(id).toBe("req-abc");
    expect(prismaMock.errorLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.errorLog.create.mock.calls[0][0].data).toMatchObject({
      method: "POST", route: "/api/admin/classes/:id/students/:id", schoolId: 7, userType: "staff", userId: 3, statusCode: 500, requestId: "req-abc",
    });
  });

  it("prefers the request id from the request context", async () => {
    const id = await requestContext.run({ requestId: "ctx-123456" }, () => tracker.captureError(errorAt("Unique failure two")));
    expect(id).toBe("ctx-123456");
  });

  it("throttles an identical error that fires in a loop", async () => {
    await tracker.captureError(errorAt("Unique failure three"));
    await tracker.captureError(errorAt("Unique failure three"));
    await tracker.captureError(errorAt("Unique failure three"));
    expect(prismaMock.errorLog.create).toHaveBeenCalledTimes(1);
  });

  it("never throws when the database is the thing that failed", async () => {
    prismaMock.errorLog.create.mockRejectedValueOnce(new Error("db down"));
    await expect(tracker.captureError(errorAt("Unique failure four"))).resolves.toBeNull();
  });

  it("purges old records", async () => {
    prismaMock.errorLog.deleteMany.mockResolvedValue({ count: 2 });
    await tracker.purgeOldErrors(90);
    expect(prismaMock.errorLog.deleteMany).toHaveBeenCalledWith({ where: { occurredAt: { lt: expect.any(Date) } } });
  });
});

describe("redact", () => {
  it("hides secrets at any depth and keeps the rest", () => {
    expect(redact({ email: "a@b.c", password: "x", nested: { Authorization: "Bearer y", ok: 1 }, list: [{ otp: "123" }] })).toEqual({
      email: "a@b.c", password: "[redacted]", nested: { Authorization: "[redacted]", ok: 1 }, list: [{ otp: "[redacted]" }],
    });
  });
});
