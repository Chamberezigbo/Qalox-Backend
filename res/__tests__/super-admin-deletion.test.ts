import { Prisma } from "@prisma/client";
import {
  DeletionBlocked,
  DeletionTargetNotFound,
  deleteAdmin,
  deleteMarketer,
  deleteToken,
  planAdminDeletion,
  planMarketerDeletion,
} from "../Services/superAdminDeletion";

/**
 * A client double over a few in-memory tables. `calls` records every write in
 * order so the tests can check what was deleted and what was left alone.
 */
function fakeClient(data: Record<string, any[]>) {
  const calls: string[] = [];
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([key, want]: [string, any]) => {
      if (want && typeof want === "object" && "in" in want) return want.in.includes(row[key]);
      if (want && typeof want === "object" && "not" in want) return row[key] !== want.not;
      return row[key] === want;
    });
  const table = (name: string) => ({
    findUnique: async ({ where }: any) => (data[name] ?? []).find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: any) => (data[name] ?? []).find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: any) => (data[name] ?? []).filter((r) => matches(r, where)),
    count: async ({ where }: any = {}) => (data[name] ?? []).filter((r) => matches(r, where)).length,
    delete: async ({ where }: any) => { calls.push(`delete:${name}:${JSON.stringify(where)}`); return {}; },
    deleteMany: async ({ where }: any) => { calls.push(`deleteMany:${name}:${JSON.stringify(where)}`); return { count: 1 }; },
    update: async ({ where, data: d }: any) => { calls.push(`update:${name}:${JSON.stringify(d)}`); return {}; },
    updateMany: async ({ where, data: d }: any) => { calls.push(`updateMany:${name}:${JSON.stringify(d)}`); return { count: 1 }; },
  });
  const client: any = new Proxy({}, { get: (_t, name: string) => (name === "$transaction" ? (fn: any) => fn(client) : table(name)) });
  return { client, calls };
}

const admin = (over: any = {}) => ({ id: 5, name: "Ada", email: "ada@x.com", role: "school_admin", schoolId: null, ...over });
const marketer = (over: any = {}) => ({ id: 9, name: "Mark", email: "m@x.com", role: "marketer", walletBalance: 0, verificationDocumentPath: null, ...over });

describe("planAdminDeletion", () => {
  it("allows an admin who never finished setting up a school", async () => {
    const { client } = fakeClient({ admin: [admin()] });
    expect((await planAdminDeletion(client, 5, 1)).blockers).toEqual([]);
  });

  it("refuses an admin who runs a school, and says to delete the school", async () => {
    const { client } = fakeClient({ admin: [admin({ schoolId: 3 })], school: [{ id: 3, name: "Good College" }] });
    const plan = await planAdminDeletion(client, 5, 1);
    expect(plan.blockers[0]).toContain("Delete the school instead");
  });

  it("refuses deleting yourself", async () => {
    const { client } = fakeClient({ admin: [admin()] });
    expect((await planAdminDeletion(client, 5, 5)).blockers.join()).toContain("your own account");
  });

  it.each(["platform_super_admin", "marketer"])("refuses the %s role", async (role) => {
    const { client } = fakeClient({ admin: [admin({ role })] });
    expect((await planAdminDeletion(client, 5, 1)).blockers.length).toBe(1);
  });

  it("refuses a sub-admin who published results", async () => {
    const { client } = fakeClient({
      admin: [admin({ role: "sub_admin", schoolId: 3 })],
      publishedResult: [{ publishedByAdminId: 5 }, { publishedByAdminId: 5 }],
    });
    expect((await planAdminDeletion(client, 5, 1)).blockers[0]).toContain("published 2 result(s)");
  });

  it("allows a sub-admin with no published results", async () => {
    const { client } = fakeClient({ admin: [admin({ role: "sub_admin", schoolId: 3 })], publishedResult: [] });
    expect((await planAdminDeletion(client, 5, 1)).blockers).toEqual([]);
  });

  it("reports an unknown admin as not found", async () => {
    const { client } = fakeClient({ admin: [] });
    await expect(planAdminDeletion(client, 5, 1)).rejects.toBeInstanceOf(DeletionTargetNotFound);
  });
});

describe("deleteAdmin", () => {
  it("removes the token the admin signed up with, then the admin", async () => {
    const { client, calls } = fakeClient({ admin: [admin()], token: [{ usedBy: 5 }] });
    await deleteAdmin(client, 5, 1);
    expect(calls).toEqual(['deleteMany:token:{"usedBy":5}', 'delete:admin:{"id":5}']);
  });

  it("deletes nothing when refused", async () => {
    const { client, calls } = fakeClient({ admin: [admin({ role: "platform_super_admin" })] });
    await expect(deleteAdmin(client, 5, 1)).rejects.toBeInstanceOf(DeletionBlocked);
    expect(calls).toEqual([]);
  });
});

describe("planMarketerDeletion", () => {
  it("allows a marketer with an empty wallet and nothing waiting", async () => {
    const { client } = fakeClient({ admin: [marketer()] });
    expect((await planMarketerDeletion(client, 9)).blockers).toEqual([]);
  });

  it("refuses while there is money in the wallet, naming the amount", async () => {
    const { client } = fakeClient({ admin: [marketer({ walletBalance: 2500 })] });
    expect((await planMarketerDeletion(client, 9)).blockers[0]).toContain("2,500.00");
  });

  it("ignores rounding noise in the wallet", async () => {
    const { client } = fakeClient({ admin: [marketer({ walletBalance: 0.001 })] });
    expect((await planMarketerDeletion(client, 9)).blockers).toEqual([]);
  });

  it("refuses while a payout is pending, but not for settled ones", async () => {
    const pending = fakeClient({ admin: [marketer()], payoutRequest: [{ marketerId: 9, status: "pending" }] });
    expect((await planMarketerDeletion(pending.client, 9)).blockers[0]).toContain("1 payout request(s) waiting");

    const settled = fakeClient({ admin: [marketer()], payoutRequest: [{ marketerId: 9, status: "approved" }] });
    expect((await planMarketerDeletion(settled.client, 9)).blockers).toEqual([]);
  });

  it("warns that referred schools stop earning commission", async () => {
    const { client } = fakeClient({ admin: [marketer()], marketerSchoolLead: [{ marketerId: 9, schoolId: 4 }] });
    expect((await planMarketerDeletion(client, 9)).warnings.join()).toContain("1 school(s)");
  });

  it("will not treat a non-marketer as a marketer", async () => {
    const { client } = fakeClient({ admin: [admin()] });
    await expect(planMarketerDeletion(client, 5)).rejects.toBeInstanceOf(DeletionTargetNotFound);
  });
});

describe("deleteMarketer", () => {
  it("removes unspent tokens, then the marketer, and returns the files to clean up", async () => {
    const { client, calls } = fakeClient({
      admin: [marketer({ verificationDocumentPath: "a.png" })],
      marketerDocument: [{ marketerId: 9, path: "a.png" }, { marketerId: 9, path: "b.png" }],
      schoolToken: [{ marketerId: 9, code: "TK1" }],
    });

    const { documentFiles } = await deleteMarketer(client, 9);

    expect(documentFiles.sort()).toEqual(["a.png", "b.png"]);
    expect(calls[0]).toContain('deleteMany:token:{"uniqueKey":{"in":["TK1"]},"usedAt":null,"usedBy":null}');
    expect(calls[calls.length - 1]).toBe('delete:admin:{"id":9}');
  });

  it("deletes nothing while the wallet holds money", async () => {
    const { client, calls } = fakeClient({ admin: [marketer({ walletBalance: 10 })] });
    await expect(deleteMarketer(client, 9)).rejects.toBeInstanceOf(DeletionBlocked);
    expect(calls).toEqual([]);
  });
});

describe("deleteToken", () => {
  const token = { id: 2, email: "s@x.com", uniqueKey: "TK1", usedAt: null, usedBy: null };

  it("deletes a plain token and clears the landing-page lead that points at it", async () => {
    const { client, calls } = fakeClient({ token: [token], schoolToken: [] });
    await deleteToken(client, 2);
    expect(calls).toEqual(['updateMany:landingPageLead:{"issuedTokenId":null}', 'delete:token:{"id":2}']);
  });

  it("deletes a marketer's paired token too, and lowers the lead's count", async () => {
    const { client, calls } = fakeClient({
      token: [token],
      schoolToken: [{ id: 7, code: "TK1", marketerId: 9, schoolEmail: "s@x.com" }],
      marketerSchoolLead: [{ id: 4, marketerId: 9, email: "s@x.com", tokensIssued: 2 }],
    });
    await deleteToken(client, 2);
    expect(calls).toContain('delete:schoolToken:{"id":7}');
    expect(calls).toContain('update:marketerSchoolLead:{"tokensIssued":{"decrement":1}}');
  });

  it("warns, but allows, deleting a used token", async () => {
    const { client } = fakeClient({ token: [{ ...token, usedAt: new Date(), usedBy: 5 }], schoolToken: [] });
    const plan = await deleteToken(client, 2);
    expect(plan.warnings[0]).toContain("already been used");
  });
});

describe("what deleting an Admin has to deal with", () => {
  const models = Prisma.dmmf.datamodel.models;

  /** Relations that point at Admin and stop it being deleted (required, and not cascading). */
  const restricting = models.flatMap((model) =>
    model.fields
      .filter((f) => f.kind === "object" && f.type === "Admin" && (f.relationFromFields?.length ?? 0) > 0 && f.isRequired && f.relationOnDelete !== "Cascade")
      .map((f) => `${model.name}.${f.name}`)
  );

  it("knows every relation that would block deleting an admin", () => {
    // PublishedResult is checked for sub-admins in planAdminDeletion. The other
    // two are written only by platform administrators, who cannot be deleted
    // here. A new entry means a new way for a delete to fail: handle it, then
    // add it here.
    expect(restricting.sort()).toEqual([
      "PlatformCommunication.createdByAdmin",
      "PublishedResult.admin",
      "SystemNotification.createdByAdmin",
    ]);
  });
});
