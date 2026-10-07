// Where an admin lands after logging in used to be worked out client-side by
// probing three endpoints and treating any non-2xx as "this data doesn't exist
// yet". That could not tell "no campuses" apart from "not allowed to read the
// campuses", so one 403 sent a fully set-up school back into the onboarding
// wizard. This endpoint answers the question once, server-side, where a
// failure can surface as a failure.
jest.mock("../util/prisma", () => ({
  admin: { findUnique: jest.fn() },
  school: { findUnique: jest.fn() },
  campus: { count: jest.fn() },
  class: { count: jest.fn() },
}));

import prisma from "../util/prisma";

const db = prisma as unknown as {
  admin: { findUnique: jest.Mock };
  school: { findUnique: jest.Mock };
  campus: { count: jest.Mock };
  class: { count: jest.Mock };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSetupStatus } = require("../controller/admin/admin");

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const run = async () => {
  const req: any = { user: { id: 17 } };
  const res = mockRes();
  const next = jest.fn();
  await getSetupStatus(req, res, next);
  return { res, next, body: res.json.mock.calls[0]?.[0] };
};

/** A school with everything in place. */
const setUpSchool = () => {
  db.admin.findUnique.mockResolvedValue({ schoolId: 5 });
  db.school.findUnique.mockResolvedValue({ id: 5 });
  db.campus.count.mockResolvedValue(1);
  db.class.count.mockResolvedValue(5);
};

beforeEach(() => jest.clearAllMocks());

describe("getSetupStatus", () => {
  it("reports a configured school as complete", async () => {
    setUpSchool();

    const { body } = await run();

    expect(body.data).toMatchObject({
      hasSchool: true,
      hasCampuses: true,
      hasClasses: true,
      currentStep: 5,
      isComplete: true,
    });
  });

  it("sends an admin with no school to step 1", async () => {
    db.admin.findUnique.mockResolvedValue({ schoolId: null });

    const { body } = await run();

    expect(body.data).toMatchObject({ hasSchool: false, currentStep: 1, isComplete: false });
    // No point counting campuses for a school that doesn't exist.
    expect(db.campus.count).not.toHaveBeenCalled();
  });

  it("sends a school with no campuses to step 2", async () => {
    setUpSchool();
    db.campus.count.mockResolvedValue(0);

    const { body } = await run();

    expect(body.data).toMatchObject({ hasCampuses: false, currentStep: 2, isComplete: false });
  });

  it("sends a school with campuses but no classes to step 3", async () => {
    setUpSchool();
    db.class.count.mockResolvedValue(0);

    const { body } = await run();

    expect(body.data).toMatchObject({
      hasCampuses: true,
      hasClasses: false,
      currentStep: 3,
      isComplete: false,
    });
  });

  it("passes a database failure to the error handler instead of reporting 'needs setup'", async () => {
    // The whole point: a failure must not be indistinguishable from an
    // unconfigured school, which is what stranded working admins in the wizard.
    db.admin.findUnique.mockRejectedValue(new Error("connection lost"));

    const { res, next } = await run();

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });

  it("counts campuses and classes scoped to the admin's own school", async () => {
    setUpSchool();

    await run();

    expect(db.campus.count).toHaveBeenCalledWith({ where: { schoolId: 5 } });
    expect(db.class.count).toHaveBeenCalledWith({ where: { schoolId: 5 } });
  });
});
