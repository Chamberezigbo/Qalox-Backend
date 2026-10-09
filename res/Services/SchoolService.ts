import { collectFileKeys, deleteSchoolData, formatNaira, CommissionSettlement } from "./schoolDeletionPlan";

class SchoolService {
  private prisma: any;

  constructor() {
    this.prisma = require("../util/prisma");
  }

  /**
   * Get school details with all associated campuses
   */
  async getSchoolWithCampuses(schoolId: number) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        campuses: {
          select: {
            id: true,
            name: true,
            address: true,
            phoneNumber: true,
            email: true,
          },
        },
        // Head admin, for the adminName/adminEmail fields the Super Admin
        // Portal renders. Both roles are matched because live data still uses
        // the legacy "super_admin" exclusively — see HEAD_ADMIN_ROLES in
        // publicController.js, which this deliberately mirrors.
        admins: {
          where: { role: { in: ["school_admin", "super_admin"] } },
          select: { name: true, email: true },
          orderBy: { id: "asc" },
          take: 1,
        },
      },
    });

    if (!school) {
      throw new Error("School not found");
    }

    return school;
  }

  /**
   * Suspend a school (mark as isSuspended = true)
   */
  async suspendSchool(
    schoolId: number,
    reason?: string
  ) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspensionReason: reason || null,
        updatedAt: new Date(),
      },
    });

    return updated;
  }

  /**
   * Reactivate a school (mark as isSuspended = false)
   */
  async reactivateSchool(schoolId: number) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        isSuspended: false,
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: new Date(),
      },
    });

    return updated;
  }

  /**
   * Permanently deletes a school and everything that belongs to it.
   *
   * What "everything" means is derived from the Prisma schema rather than
   * listed here — see schoolDeletionPlan.ts for why a hand-kept list could not
   * be trusted. The database work is one transaction, so a failure part-way
   * leaves the school exactly as it was. Stored files are removed afterwards,
   * best effort: an orphaned file is harmless, a half-deleted school is not.
   */
  async deleteSchoolCascade(schoolId: number, reason?: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new Error("School not found");
    }

    // Read before anything is deleted — the rows holding these keys are gone
    // once the transaction commits.
    const fileKeys = await collectFileKeys(this.prisma, schoolId);

    const settlements: CommissionSettlement[] = [];
    const deleted = await this.prisma.$transaction(
      // A retried transaction starts over, so the list is emptied each attempt.
      (tx: any) => { settlements.length = 0; return deleteSchoolData(tx, schoolId, settlements); },
      // Prisma's default is 5 seconds, which a delete across this many tables
      // can exceed on its own.
      { timeout: 5 * 60 * 1000, maxWait: 10 * 1000 }
    );

    const filesRemoved = await this.removeStoredFiles(fileKeys);
    const marketersEmailed = await this.emailMarketers(settlements);

    return {
      id: school.id,
      name: school.name,
      deletedAt: new Date(),
      deletionReason: reason || null,
      deleted,
      filesRemoved,
      commissionsSettled: settlements.map(({ marketerId, count, total, creditedNow }) => ({ marketerId, count, total, creditedNow })),
      marketersEmailed,
    };
  }

  /**
   * Tells each marketer what became of their commissions. Runs after the
   * deletion has committed and never fails it: the money is already settled and
   * the in-app notification already written, so an email is a courtesy.
   */
  private async emailMarketers(settlements: CommissionSettlement[]): Promise<number> {
    if (settlements.length === 0) return 0;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sendEmail } = require("./EmailService");
    const escape = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let sent = 0;

    for (const s of settlements) {
      try {
        await sendEmail({
          to: s.marketerEmail,
          subject: `${s.schoolName} was deleted — your commissions are settled`,
          html:
            `<p>Hello ${escape(s.marketerName)},</p>` +
            `<p><strong>${escape(s.schoolName)}</strong>, a school you referred, was deleted from Qalox.</p>` +
            `<p>Your commissions from it: <strong>${formatNaira(s.total)}</strong> across ${s.count} record(s).` +
            (s.creditedNow > 0
              ? ` <strong>${formatNaira(s.creditedNow)}</strong> of that had not yet reached your wallet and has been added now.`
              : " All of it was already in your wallet.") +
            `</p><p>Nothing you earned has been lost. Your wallet history still shows every credit.</p>`,
        });
        sent += 1;
      } catch (error: any) {
        console.warn(`[DELETE_SCHOOL] Could not email marketer ${s.marketerId}: ${error?.message}`);
      }
    }

    return sent;
  }

  /** Best-effort removal of a deleted school's files from object storage. */
  private async removeStoredFiles(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const r2Service = require("./R2Service");
    let removed = 0;

    for (const key of keys) {
      try {
        await r2Service.deleteObject(key);
        removed += 1;
      } catch (error: any) {
        // Not worth failing a completed deletion over.
        console.warn(`[DELETE_SCHOOL] Could not remove stored file ${key}: ${error?.message}`);
      }
    }

    return removed;
  }
}

module.exports = { SchoolService };
