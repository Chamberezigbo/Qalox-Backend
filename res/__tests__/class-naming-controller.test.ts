jest.mock("../util/prisma", () => ({
  class: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn((a) => a), createMany: jest.fn() },
  campus: { findFirst: jest.fn() },
  $transaction: jest.fn(),
}));

const prismaMock = require("../util/prisma");
export {};
const controller = require("../controller/admin/ClassNamingController");

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const req = (body: any, extra: any = {}) => ({ schoolId: 1, campusIds: null, body, ...extra });

const classes = [
  { id: 1, name: "Primary 1", campusId: null },
  { id: 2, name: "Primary 2", campusId: null },
  { id: 3, name: "JSS 1", campusId: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.class.findMany.mockImplementation(({ select }: any) =>
    Promise.resolve(select?.campusId ? classes : classes.map((c) => ({ id: c.id }))),
  );
});

describe("rename", () => {
  it("previews without changing anything", async () => {
    const res = mockRes();
    await controller.rename(req({ from: "Primary", to: "Grade", preview: true }), res, jest.fn());
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { preview: true, changes: [
      { id: 1, from: "Primary 1", to: "Grade 1" }, { id: 2, from: "Primary 2", to: "Grade 2" },
    ] } });
  });

  it("renames the whole system in one transaction", async () => {
    const res = mockRes();
    await controller.rename(req({ from: "Primary", to: "Grade" }), res, jest.fn());
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.class.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { name: "Grade 1" } });
    expect(prismaMock.class.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { name: "Grade 2" } });
  });

  it("refuses a name that ends in a number, and a clash with another class", async () => {
    let res = mockRes();
    await controller.rename(req({ from: "Primary", to: "Grade 1" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);

    res = mockRes();
    await controller.rename(req({ from: "Primary", to: "JSS" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("404s when no class uses the old name", async () => {
    const res = mockRes();
    await controller.rename(req({ from: "Basic", to: "Grade" }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("addSystem", () => {
  it("creates only the classes that do not exist yet", async () => {
    prismaMock.class.findMany.mockResolvedValueOnce([{ name: "Grade 2" }]);
    const res = mockRes();
    await controller.addSystem(req({ name: "Grade", start: 1, end: 3 }), res, jest.fn());
    expect(prismaMock.class.createMany).toHaveBeenCalledWith({
      data: [{ schoolId: 1, campusId: null, name: "Grade 1" }, { schoolId: 1, campusId: null, name: "Grade 3" }],
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects a bad range", async () => {
    const res = mockRes();
    await controller.addSystem(req({ name: "Grade", start: 5, end: 2 }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prismaMock.class.createMany).not.toHaveBeenCalled();
  });

  it("makes a campus sub-admin choose one of their campuses", async () => {
    const res = mockRes();
    await controller.addSystem(req({ name: "Grade", start: 1, end: 2 }, { campusIds: [4] }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
