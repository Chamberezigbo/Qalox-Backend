// A school often registers a staff member before it has their email, start
// date, next of kin or salary. All four columns are nullable, but three layers
// above the database disagreed: Joi required email outright, the duplicate
// check ran unconditionally, and blanks were coerced into 0 and NaN.
jest.mock("../util/prisma", () => ({
  school: { findUnique: jest.fn() },
  staff: { findUnique: jest.fn(), create: jest.fn() },
}));

jest.mock("../Models/generateUniqueIdentifier", () => ({
  generateUniqueIdentifier: jest.fn().mockReturnValue("DSCS-0001-STA"),
}));

jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));

import prisma from "../util/prisma";
import { staffSchema } from "../schemas/adminSchemas";

const db = prisma as unknown as {
  school: { findUnique: jest.Mock };
  staff: { findUnique: jest.Mock; create: jest.Mock };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStaff } = require("../controller/admin/StaffController");

/** Minimal Express doubles — the controller only uses status/json. */
const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const runCreate = async (body: Record<string, unknown>) => {
  const req: any = { body, schoolId: 5 };
  const res = mockRes();
  const next = jest.fn();
  await createStaff(req, res, next);
  return { res, next };
};

beforeEach(() => {
  jest.clearAllMocks();
  db.school.findUnique.mockResolvedValue({ prefix: "DSCS" });
  db.staff.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 1, ...data }));
});

describe("staffSchema — what the form is allowed to leave out", () => {
  it("accepts a staff member with only a name and a duty", () => {
    const { error } = staffSchema.validate({ name: "Ada Obi", duty: "Teacher" });
    expect(error).toBeUndefined();
  });

  it("accepts empty strings for every optional field", () => {
    // The form posts "" for anything untouched, and Joi's .optional() alone
    // rejects an empty string — including for date and number fields.
    const { error } = staffSchema.validate({
      name: "Ada Obi",
      duty: "Teacher",
      email: "",
      gender: "",
      phoneNumber: "",
      address: "",
      nextOfKin: "",
      dateEmployed: "",
      payroll: "",
      campusId: null,
    });
    expect(error).toBeUndefined();
  });

  it("still requires a name and a duty", () => {
    expect(staffSchema.validate({ duty: "Teacher" }).error).toBeDefined();
    expect(staffSchema.validate({ name: "Ada Obi" }).error).toBeDefined();
  });

  it("still rejects a malformed email when one is given", () => {
    const { error } = staffSchema.validate({ name: "Ada Obi", duty: "Teacher", email: "nope" });
    expect(error).toBeDefined();
  });
});

describe("createStaff — a staff member with nothing optional filled in", () => {
  it("does not look up a duplicate email when none was given", async () => {
    await runCreate({ name: "Ada Obi", duty: "Teacher" });

    // findUnique({ where: { email: undefined } }) throws rather than returning
    // null, so running this check unconditionally is what blocked the whole
    // registration.
    expect(db.staff.findUnique).not.toHaveBeenCalled();
    expect(db.staff.create).toHaveBeenCalledTimes(1);
  });

  it("stores null, not empty strings, for the fields left blank", async () => {
    await runCreate({
      name: "Ada Obi",
      duty: "Teacher",
      email: "",
      gender: "",
      phoneNumber: "",
      address: "",
      nextOfKin: "",
      dateEmployed: "",
      payroll: "",
    });

    const { data } = db.staff.create.mock.calls[0][0];
    // "" would defeat the unique index on email: MySQL allows many NULLs but
    // treats "" as a real value, so the second such staff member would collide.
    expect(data.email).toBeNull();
    expect(data.gender).toBeNull();
    expect(data.phoneNumber).toBeNull();
    expect(data.address).toBeNull();
    expect(data.nextOfKin).toBeNull();
    expect(data.dateEmployed).toBeNull();
  });

  it("leaves an unrecorded salary null rather than storing it as zero", async () => {
    await runCreate({ name: "Ada Obi", duty: "Teacher", payroll: "" });

    const { data } = db.staff.create.mock.calls[0][0];
    // Number("") is 0, which would read back as a real salary of ₦0.
    expect(data.payroll).toBeNull();
    expect(data.payroll).not.toBe(0);
  });

  it("keeps a real salary of zero when that is what was entered", async () => {
    await runCreate({ name: "Ada Obi", duty: "Teacher", payroll: 0 });

    expect(db.staff.create.mock.calls[0][0].data.payroll).toBe(0);
  });
});

describe("createStaff — when an email is given", () => {
  it("still refuses a duplicate", async () => {
    db.staff.findUnique.mockResolvedValue({ id: 9, email: "ada@school.ng" });

    const { res } = await runCreate({
      name: "Ada Obi",
      duty: "Teacher",
      email: "ada@school.ng",
    });

    expect(db.staff.findUnique).toHaveBeenCalledWith({ where: { email: "ada@school.ng" } });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(db.staff.create).not.toHaveBeenCalled();
  });

  it("creates when the email is new", async () => {
    db.staff.findUnique.mockResolvedValue(null);

    const { res } = await runCreate({
      name: "Ada Obi",
      duty: "Teacher",
      email: "  ada@school.ng  ",
    });

    expect(db.staff.create.mock.calls[0][0].data.email).toBe("ada@school.ng");
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
