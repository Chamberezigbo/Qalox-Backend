// "Teacher" is the one duty with real meaning — it is what lets someone into the
// teacher portal. Login used to compare it with an exact `!== "Teacher"`, so a
// stray capital or trailing space ("teacher", "Teacher ") locked a teacher out,
// while the assign-teacher list matched the same value through MySQL (which is
// case-insensitive) and showed them as a teacher anyway.
jest.mock("../util/prisma", () => ({
  staff: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  school: { findUnique: jest.fn() },
}));
jest.mock("../util/jwt", () => ({ signTeacherToken: jest.fn().mockReturnValue("signed-token") }));
jest.mock("../util/logLoginEvent", () => ({ logLoginEvent: jest.fn() }));
jest.mock("../Models/generateUniqueIdentifier", () => ({
  generateUniqueIdentifier: jest.fn().mockReturnValue("DSCS-0001-STA"),
}));
jest.mock("../util/notify", () => ({ createNotification: jest.fn() }));

import prisma from "../util/prisma";
import { normalizeDuty, isTeacherDuty, STAFF_DUTIES } from "../util/staffDuty";
import { TeacherAuthService } from "../Services/auth/TeacherAuthService";

const db = prisma as unknown as {
  staff: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  school: { findUnique: jest.Mock };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStaff, updateStaff } = require("../controller/admin/StaffController");

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe("normalizeDuty", () => {
  it("restores the standard spelling of a known duty", () => {
    expect(normalizeDuty("teacher")).toBe("Teacher");
    expect(normalizeDuty("TEACHER")).toBe("Teacher");
    expect(normalizeDuty("ict officer")).toBe("ICT Officer");
    expect(normalizeDuty("MANAGER")).toBe("Manager");
  });

  it("trims and collapses stray spaces", () => {
    expect(normalizeDuty("  Teacher ")).toBe("Teacher");
    expect(normalizeDuty("Human   Resources")).toBe("Human Resources");
  });

  it("keeps a role no list anticipates exactly as typed", () => {
    expect(normalizeDuty("Provost")).toBe("Provost");
    expect(normalizeDuty("Hostel  Matron")).toBe("Hostel Matron");
  });

  it("returns null when there is nothing meaningful", () => {
    expect(normalizeDuty("")).toBeNull();
    expect(normalizeDuty("   ")).toBeNull();
    expect(normalizeDuty(undefined)).toBeNull();
    expect(normalizeDuty(null)).toBeNull();
  });

  it("does not treat a near-miss as a teacher", () => {
    // "Teachers" or "Teacher Assistant" are not the Teacher duty.
    expect(normalizeDuty("Teachers")).toBe("Teachers");
    expect(isTeacherDuty("Teacher Assistant")).toBe(false);
    expect(isTeacherDuty("Teachers")).toBe(false);
  });

  it("offers Teacher first in the standard list", () => {
    expect(STAFF_DUTIES[0]).toBe("Teacher");
  });
});

describe("teacher login", () => {
  const login = (duty: string | null) => {
    db.staff.findUnique.mockResolvedValue({
      id: 3,
      name: "Mr Atiba",
      schoolId: 5,
      campusId: null,
      registrationNumber: "DSCS-30",
      duty,
      school: { id: 5, name: "Daniel's College" },
      campus: null,
    });
    return new TeacherAuthService().login({ registrationNumber: "DSCS-30" } as any);
  };

  it.each(["Teacher", "teacher", "TEACHER", "Teacher ", "  teacher"])(
    "lets %p in",
    async (duty) => {
      await expect(login(duty)).resolves.toMatchObject({ token: "signed-token" });
    }
  );

  it.each(["Security", "Bursar", "Teachers", "", null])("keeps %p out", async (duty) => {
    await expect(login(duty as string | null)).rejects.toThrow("Access denied");
  });
});

describe("createStaff — duty", () => {
  const create = async (duty: unknown) => {
    db.school.findUnique.mockResolvedValue({ prefix: "DSCS" });
    db.staff.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 1, ...data }));
    const res = mockRes();
    await createStaff({ body: { name: "Ada Obi", duty }, schoolId: 5 }, res, jest.fn());
    return res;
  };

  it("stores a typed duty in its standard spelling", async () => {
    await create(" teacher ");
    expect(db.staff.create.mock.calls[0][0].data.duty).toBe("Teacher");
  });

  it("refuses a duty made only of spaces, which Joi lets through", async () => {
    const res = await create("   ");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.staff.create).not.toHaveBeenCalled();
  });
});

describe("updateStaff — blanks from the edit form", () => {
  // The edit schema accepts "" so a field can be cleared, but the body used to
  // reach the database untouched: a blank email was stored as "" and would
  // collide under the unique index, and a blank date or salary is not a valid
  // DateTime or Decimal at all.
  const update = async (body: Record<string, unknown>) => {
    db.staff.findUnique.mockResolvedValue({ id: 9 });
    db.staff.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 9, ...data }));
    const res = mockRes();
    await updateStaff({ params: { staffId: "9" }, body: { ...body } }, res, jest.fn());
    return res;
  };

  it("turns cleared optional fields into null", async () => {
    await update({ email: "", gender: "", dateEmployed: "", payroll: "", phoneNumber: "" });

    const { data } = db.staff.update.mock.calls[0][0];
    expect(data).toMatchObject({
      email: null,
      gender: null,
      dateEmployed: null,
      payroll: null,
      phoneNumber: null,
    });
  });

  it("converts a real date and salary", async () => {
    await update({ dateEmployed: "2024-09-01", payroll: "150000" });

    const { data } = db.staff.update.mock.calls[0][0];
    expect(data.dateEmployed).toBeInstanceOf(Date);
    expect(data.payroll).toBe(150000);
  });

  it("normalises the duty it is given", async () => {
    await update({ duty: "teacher" });
    expect(db.staff.update.mock.calls[0][0].data.duty).toBe("Teacher");
  });

  it("refuses to blank a duty", async () => {
    const res = await update({ duty: "  " });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.staff.update).not.toHaveBeenCalled();
  });

  it("leaves fields it was not sent alone", async () => {
    await update({ name: "Ada Obi" });

    const { data } = db.staff.update.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(["name"]);
  });
});
