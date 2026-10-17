// Who may be made a class teacher: a real Teacher of the same school, and of the
// class's campus when both have one.
/* eslint-disable @typescript-eslint/no-var-requires */
const { classTeacherProblem } = require("../util/classTeacher");

const client = (staff: object | null) => ({ staff: { findFirst: jest.fn().mockResolvedValue(staff) } });

describe("classTeacherProblem", () => {
  it("accepts a teacher of the school", async () => {
    expect(await classTeacherProblem(client({ id: 1, duty: "Teacher", campusId: 2 }), { schoolId: 7, staffId: 1, campusId: 2 })).toBeNull();
  });

  it("accepts a teacher with no campus for any campus, and a class with no campus", async () => {
    expect(await classTeacherProblem(client({ id: 1, duty: "Teacher", campusId: null }), { schoolId: 7, staffId: 1, campusId: 2 })).toBeNull();
    expect(await classTeacherProblem(client({ id: 1, duty: "Teacher", campusId: 2 }), { schoolId: 7, staffId: 1, campusId: null })).toBeNull();
  });

  it("is tolerant about how the duty is written", async () => {
    expect(await classTeacherProblem(client({ id: 1, duty: " teacher ", campusId: null }), { schoolId: 7, staffId: 1, campusId: null })).toBeNull();
  });

  it("refuses staff who are not teachers", async () => {
    expect(await classTeacherProblem(client({ id: 1, duty: "Bursar", campusId: null }), { schoolId: 7, staffId: 1, campusId: null })).toContain("Teacher");
  });

  it("refuses staff from another school (looked up by school) and from another campus", async () => {
    const c = client(null);
    expect(await classTeacherProblem(c, { schoolId: 7, staffId: 1, campusId: null })).toContain("not found");
    expect(c.staff.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, schoolId: 7 } }));
    expect(await classTeacherProblem(client({ id: 1, duty: "Teacher", campusId: 3 }), { schoolId: 7, staffId: 1, campusId: 2 })).toContain("different campus");
  });
});

export {};
