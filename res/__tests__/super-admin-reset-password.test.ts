const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockSendEmail = jest.fn();

jest.mock("../util/prisma", () => ({ admin: { findUnique: (...a: any[]) => mockFindUnique(...a), update: (...a: any[]) => mockUpdate(...a) } }));
jest.mock("../Services/EmailService", () => ({ sendEmail: (...a: any[]) => mockSendEmail(...a) }));

const { resetSchoolAdminPassword } = require("../controller/superadmin/SuperAdminController");

const run = async (admin: any) => {
  mockFindUnique.mockResolvedValue(admin);
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await resetSchoolAdminPassword({ params: { id: "5" } }, res, next);
  return { res, next };
};

beforeEach(() => jest.clearAllMocks());

describe("resetSchoolAdminPassword", () => {
  it.each(["school_admin", "super_admin"])("resets a %s", async (role) => {
    mockSendEmail.mockResolvedValue({});
    const { res } = await run({ id: 5, name: "Ada", email: "a@x.com", role });
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.emailed).toBe(true);
    expect(mockSendEmail.mock.calls[0][0].html).toContain(body.data.temporaryPassword);
  });

  it("still succeeds, and says so, when the email fails", async () => {
    mockSendEmail.mockRejectedValue(new Error("down"));
    const { res } = await run({ id: 5, name: "Ada", email: "a@x.com", role: "school_admin" });
    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.emailed).toBe(false);
    expect(body.message).toContain("could not be sent");
  });

  it.each(["marketer", "sub_admin", "platform_super_admin"])("refuses a %s", async (role) => {
    const { res } = await run({ id: 5, name: "X", email: "x@x.com", role });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
