jest.mock("../util/prisma", () => ({
  teacherAssignment: { findMany: jest.fn(), findFirst: jest.fn() },
  class: { findFirst: jest.fn() },
  staff: { findFirst: jest.fn() },
  classGroup: { findFirst: jest.fn() },
  student: { findMany: jest.fn() },
  attendance: { findMany: jest.fn() },
}));

export {};
const prismaMock = require("../util/prisma");
const controller = require("../controller/admin/AttendanceOverviewController");
const { parseIsoDate, weekDays, summarizeStudent } = require("../util/attendanceWeek");

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const req = (query: any, extra: any = {}) => ({ schoolId: 1, campusIds: null, query, ...extra });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("week helpers", () => {
  it("gives Monday to Friday for any day in the week", () => {
    const expected = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
    expect(weekDays(parseIsoDate("2026-11-11"))).toEqual(expected);
    expect(weekDays(parseIsoDate("2026-11-09"))).toEqual(expected);
    expect(weekDays(parseIsoDate("2026-11-15"))).toEqual(expected); // Sunday belongs to the week just ended
  });
  it("rejects dates that are not real", () => {
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("11/11/2026")).toBeNull();
  });
  it("counts late as attended, over the days that were marked", () => {
    expect(summarizeStudent(["present", "late", "absent", null, null])).toEqual({ present: 1, absent: 1, late: 1, pct: 67 });
    expect(summarizeStudent([null, null, null, null, null]).pct).toBe(0);
  });
});

describe("listTeachers", () => {
  it("groups each teacher's classes once", async () => {
    prismaMock.teacherAssignment.findMany.mockResolvedValue([
      { staff: { id: 1, name: "Ade", registrationNumber: "T1" }, class: { id: 10, name: "JSS 1", customName: null, campusId: null } },
      { staff: { id: 1, name: "Ade", registrationNumber: "T1" }, class: { id: 10, name: "JSS 1", customName: null, campusId: null } },
      { staff: { id: 1, name: "Ade", registrationNumber: "T1" }, class: { id: 11, name: "JSS 2", customName: null, campusId: null } },
    ]);
    const res = mockRes();
    await controller.listTeachers(req({}), res, jest.fn());
    const data = res.json.mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    expect(data[0].classes.map((c: any) => c.id)).toEqual([10, 11]);
  });

  it("limits a campus sub-admin to their campuses", async () => {
    prismaMock.teacherAssignment.findMany.mockResolvedValue([]);
    await controller.listTeachers(req({}, { campusIds: [4] }), mockRes(), jest.fn());
    const where = prismaMock.teacherAssignment.findMany.mock.calls.at(-1)[0].where;
    expect(JSON.stringify(where)).toContain('"campusId":{"in":[4]}');
    expect(where.class).toBeDefined();
  });
});

describe("broadsheet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.class.findFirst.mockResolvedValue({ id: 10, name: "JSS 1", customName: null });
    prismaMock.staff.findFirst.mockResolvedValue({ id: 1, name: "Ade", registrationNumber: "T1" });
    prismaMock.teacherAssignment.findFirst.mockResolvedValue({ id: 99 });
    prismaMock.student.findMany.mockResolvedValue([
      { id: 5, name: "Bola", surname: "Ojo", otherNames: "", registrationNumber: "S5" },
      { id: 6, name: "Chi", surname: "Eze", otherNames: "", registrationNumber: "S6" },
    ]);
    prismaMock.attendance.findMany.mockResolvedValue([
      { studentId: 5, date: day("2026-11-09"), status: "present", markedByStaff: { name: "Ade" } },
      { studentId: 6, date: day("2026-11-09"), status: "absent", markedByStaff: { name: "Ade" } },
      { studentId: 5, date: day("2026-11-10"), status: "late", markedByStaff: { name: "Sub Teacher" } },
    ]);
  });

  it("builds the week with totals and which days were taken", async () => {
    const res = mockRes();
    await controller.broadsheet(req({ staffId: "1", classId: "10", weekStart: "2026-11-11" }), res, jest.fn());
    const { data } = res.json.mock.calls[0][0];
    expect(data.week.days[0]).toBe("2026-11-09");
    expect(data.students[0]).toMatchObject({ id: 5, days: ["present", "late", null, null, null], present: 1, late: 1, pct: 100 });
    expect(data.students[1]).toMatchObject({ id: 6, absent: 1, pct: 0 });
    expect(data.daySummary.map((d: any) => d.taken)).toEqual([true, true, false, false, false]);
    expect(data.daySummary[1].markedBy).toEqual(["Sub Teacher"]);
    expect(data.totals).toMatchObject({ present: 1, absent: 1, late: 1, classRate: 67, daysTaken: 2 });
  });

  it("404s a class or teacher the admin cannot see (another campus)", async () => {
    prismaMock.class.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await controller.broadsheet(req({ staffId: "1", classId: "10" }, { campusIds: [4] }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(prismaMock.student.findMany).not.toHaveBeenCalled();
  });

  it("404s when the teacher is not assigned to the class", async () => {
    prismaMock.teacherAssignment.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await controller.broadsheet(req({ staffId: "1", classId: "10" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json.mock.calls[0][0].message).toContain("does not take attendance");
  });

  it("rejects bad input", async () => {
    let res = mockRes();
    await controller.broadsheet(req({ classId: "10" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    res = mockRes();
    await controller.broadsheet(req({ staffId: "1", classId: "10", weekStart: "nonsense" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
