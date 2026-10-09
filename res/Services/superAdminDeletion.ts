/**
 * Super Admin deletion of registration tokens, school admins and marketers.
 *
 * Each target has a plan step that only reads, and a delete step that writes.
 * The plan returns what would be removed and, when the delete is not safe,
 * the reasons it is refused. The delete step runs the same plan again inside
 * its own transaction, so a refusal cannot be skipped by calling it directly
 * and a change made between the preview and the delete is still caught.
 *
 * With `relationMode = "prisma"` there are no database foreign keys: Prisma
 * itself emulates `onDelete: Cascade` and refuses `Restrict`. That is what
 * removes a marketer's commissions, wallet history and payouts with them, and
 * what would stop a school admin who published results from being deleted.
 */

export type DeletionTarget = "token" | "admin" | "marketer";

export interface DeletionPlan {
  target: DeletionTarget;
  id: number;
  /** What the confirm dialog calls it: an email address or a name. */
  label: string;
  /** Why this cannot be deleted right now. Empty when it can. */
  blockers: string[];
  /** Things that are lost or change as a result, for the dialog to list. */
  warnings: string[];
  /** Rows that go with it, by kind. */
  willRemove: Record<string, number>;
}

/** Thrown when a plan has blockers. Carries the plan so the response can show why. */
export class DeletionBlocked extends Error {
  readonly code = "DELETION_BLOCKED";
  constructor(readonly plan: DeletionPlan) {
    super(plan.blockers[0] ?? "This cannot be deleted");
  }
}

export class DeletionTargetNotFound extends Error {
  readonly code = "NOT_FOUND";
}

/** Roles that belong to a school and are removed here. Platform admins and marketers are not. */
export const SCHOOL_ADMIN_ROLES = ["school_admin", "super_admin", "sub_admin"] as const;

/** A wallet balance below this is rounding noise, not money owed. */
const WALLET_EPSILON = 0.005;

const naira = (amount: number): string =>
  `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function planTokenDeletion(client: any, tokenId: number): Promise<DeletionPlan> {
  const token = await client.token.findUnique({ where: { id: tokenId } });
  if (!token) throw new DeletionTargetNotFound("Token not found");

  // A marketer's token lives in two tables that share a code.
  const schoolToken = await client.schoolToken.findFirst({
    where: { code: token.uniqueKey },
    select: { id: true },
  });

  const warnings: string[] = [];
  if (token.usedAt || token.usedBy) {
    warnings.push(
      "This token has already been used to register a school admin. The school keeps working, but it will no longer show which token it came from."
    );
  }

  return {
    target: "token",
    id: tokenId,
    label: token.email,
    blockers: [],
    warnings,
    willRemove: { Token: 1, ...(schoolToken ? { SchoolToken: 1 } : {}) },
  };
}

export async function deleteToken(prisma: any, tokenId: number): Promise<DeletionPlan> {
  return prisma.$transaction(async (tx: any) => {
    const plan = await planTokenDeletion(tx, tokenId);
    if (plan.blockers.length > 0) throw new DeletionBlocked(plan);

    const token = await tx.token.findUnique({ where: { id: tokenId } });
    const schoolToken = await tx.schoolToken.findFirst({
      where: { code: token.uniqueKey },
      select: { id: true, marketerId: true, schoolEmail: true },
    });

    if (schoolToken) {
      await tx.schoolToken.delete({ where: { id: schoolToken.id } });

      // The marketer's lead counts the tokens issued to it; keep the count honest.
      const lead = await tx.marketerSchoolLead.findFirst({
        where: { marketerId: schoolToken.marketerId, email: schoolToken.schoolEmail },
        select: { id: true, tokensIssued: true },
      });
      if (lead && lead.tokensIssued > 0) {
        await tx.marketerSchoolLead.update({ where: { id: lead.id }, data: { tokensIssued: { decrement: 1 } } });
      }
    }

    // A landing-page lead remembers the token issued to it by id only.
    await tx.landingPageLead.updateMany({ where: { issuedTokenId: tokenId }, data: { issuedTokenId: null } });

    await tx.token.delete({ where: { id: tokenId } });
    return plan;
  });
}

// ---------------------------------------------------------------------------
// School admins
// ---------------------------------------------------------------------------

export async function planAdminDeletion(client: any, adminId: number, actorId: number | null): Promise<DeletionPlan> {
  const admin = await client.admin.findUnique({
    where: { id: adminId },
    select: { id: true, name: true, email: true, role: true, schoolId: true },
  });
  if (!admin) throw new DeletionTargetNotFound("Admin not found");

  const blockers: string[] = [];
  const warnings: string[] = [];
  const willRemove: Record<string, number> = { Admin: 1 };

  if (!(SCHOOL_ADMIN_ROLES as readonly string[]).includes(admin.role)) {
    blockers.push(
      admin.role === "marketer"
        ? "This is a marketer. Delete it from the Marketers page."
        : "Platform administrators cannot be deleted here."
    );
  }

  if (actorId !== null && admin.id === actorId) {
    blockers.push("You cannot delete your own account.");
  }

  if (admin.role !== "sub_admin" && admin.schoolId) {
    const school = await client.school.findUnique({ where: { id: admin.schoolId }, select: { name: true } });
    if (school) {
      blockers.push(
        `${admin.name} runs ${school.name}. Delete the school instead — that removes the school, its admins and everything in it.`
      );
    }
  }

  if (admin.role === "sub_admin") {
    // Required relation without a cascade: Prisma refuses to delete the admin.
    const published = await client.publishedResult.count({ where: { publishedByAdminId: admin.id } });
    if (published > 0) {
      blockers.push(
        `This sub-admin published ${published} result(s), which must keep their publisher. Suspend the account instead.`
      );
    }
  }

  const tokens = await client.token.count({ where: { usedBy: admin.id } });
  if (tokens > 0) {
    willRemove.Token = tokens;
    warnings.push("The registration token this admin signed up with is removed too, so the email can be issued a fresh one.");
  }

  return { target: "admin", id: adminId, label: admin.email, blockers, warnings, willRemove };
}

export async function deleteAdmin(prisma: any, adminId: number, actorId: number | null): Promise<DeletionPlan> {
  return prisma.$transaction(async (tx: any) => {
    const plan = await planAdminDeletion(tx, adminId, actorId);
    if (plan.blockers.length > 0) throw new DeletionBlocked(plan);

    // Token.email is unique: leaving the used token behind would stop this
    // email from ever being issued another one.
    await tx.token.deleteMany({ where: { usedBy: adminId } });
    await tx.admin.delete({ where: { id: adminId } });
    return plan;
  });
}

// ---------------------------------------------------------------------------
// Marketers
// ---------------------------------------------------------------------------

export async function planMarketerDeletion(client: any, marketerId: number): Promise<DeletionPlan> {
  const marketer = await client.admin.findUnique({
    where: { id: marketerId },
    select: { id: true, name: true, email: true, role: true, walletBalance: true },
  });
  if (!marketer || marketer.role !== "marketer") throw new DeletionTargetNotFound("Marketer not found");

  const blockers: string[] = [];
  const warnings: string[] = [];

  const balance = marketer.walletBalance ?? 0;
  if (balance > WALLET_EPSILON) {
    blockers.push(
      `${marketer.name} still has ${naira(balance)} in their wallet. Pay it out (or write it off) before deleting.`
    );
  }

  const pendingPayouts = await client.payoutRequest.count({ where: { marketerId, status: "pending" } });
  if (pendingPayouts > 0) {
    blockers.push(`${marketer.name} has ${pendingPayouts} payout request(s) waiting. Approve or reject them first.`);
  }

  const [commissions, walletTransactions, payouts, leads, schoolTokens, documents, referredSchools] = await Promise.all([
    client.commission.count({ where: { marketerId } }),
    client.walletTransaction.count({ where: { marketerId } }),
    client.payoutRequest.count({ where: { marketerId } }),
    client.marketerSchoolLead.count({ where: { marketerId } }),
    client.schoolToken.count({ where: { marketerId } }),
    client.marketerDocument.count({ where: { marketerId } }),
    client.marketerSchoolLead.count({ where: { marketerId, schoolId: { not: null } } }),
  ]);

  if (referredSchools > 0) {
    warnings.push(
      `${referredSchools} school(s) this marketer referred stay live, but will stop earning commission for anyone.`
    );
  }
  if (commissions + walletTransactions + payouts > 0) {
    warnings.push("Their commission, wallet and payout history is deleted with them and cannot be recovered.");
  }

  const willRemove: Record<string, number> = { Admin: 1 };
  const counts: Record<string, number> = {
    Commission: commissions,
    WalletTransaction: walletTransactions,
    PayoutRequest: payouts,
    MarketerSchoolLead: leads,
    SchoolToken: schoolTokens,
    MarketerDocument: documents,
  };
  for (const [name, count] of Object.entries(counts)) if (count > 0) willRemove[name] = count;

  return { target: "marketer", id: marketerId, label: marketer.email, blockers, warnings, willRemove };
}

/**
 * Deletes a marketer and what hangs off them.
 *
 * @returns the plan, and the stored identity-document filenames to remove from
 * disk once the transaction has committed (a file cannot be rolled back).
 */
export async function deleteMarketer(
  prisma: any,
  marketerId: number
): Promise<{ plan: DeletionPlan; documentFiles: string[] }> {
  return prisma.$transaction(
    async (tx: any) => {
      const plan = await planMarketerDeletion(tx, marketerId);
      if (plan.blockers.length > 0) throw new DeletionBlocked(plan);

      const admin = await tx.admin.findUnique({ where: { id: marketerId }, select: { verificationDocumentPath: true } });
      const documents: Array<{ path: string }> = await tx.marketerDocument.findMany({
        where: { marketerId },
        select: { path: true },
      });
      const documentFiles = [...new Set([admin?.verificationDocumentPath, ...documents.map((d) => d.path)])].filter(
        (name): name is string => typeof name === "string" && name.length > 0
      );

      // Their tokens are also rows in `tokens` (same code). Spent ones stay: they
      // record how an existing school admin signed up. Everything else would
      // otherwise sit in the Super Admin list pointing at a marketer who is gone.
      const schoolTokens: Array<{ code: string }> = await tx.schoolToken.findMany({
        where: { marketerId },
        select: { code: true },
      });
      if (schoolTokens.length > 0) {
        await tx.token.deleteMany({
          where: { uniqueKey: { in: schoolTokens.map((t) => t.code) }, usedAt: null, usedBy: null },
        });
      }

      // Cascades (emulated by Prisma): commissions, wallet transactions, payout
      // requests, leads, school tokens, documents, notifications, recovery codes
      // and security events.
      await tx.admin.delete({ where: { id: marketerId } });
      return { plan, documentFiles };
    },
    { timeout: 60 * 1000, maxWait: 10 * 1000 }
  );
}
