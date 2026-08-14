/**
 * Notify users whose 2FA enrolment was cleared by the real-TOTP migration.
 *
 * The migration (20260813020000_real_totp_2fa) already set twoFactorEnabled to
 * false for everyone. It could not send email, so this script does that half:
 * it finds accounts that had a dummy enrolment and tells them to re-enrol.
 *
 * Why they were reset: every one of them was "enrolled" against the shared
 * hardcoded secret JBSWY3DPEBLW64TMMQ======, a published example value. Any
 * authenticator seeded with it produces codes that would work for every other
 * such account, so there was nothing worth carrying forward.
 *
 * Usage:
 *   node scripts/reset-dummy-2fa.js --dry-run   # list who would be emailed
 *   node scripts/reset-dummy-2fa.js             # clear secrets + send email
 */

require("dotenv").config();

const prisma = require("../res/util/prisma");
const emailService = require("../res/Services/EmailService");

const DRY_RUN = process.argv.includes("--dry-run");

const html = (name) => `
  <p>Hello ${name || ""},</p>
  <p>We have reset two-factor authentication on your Qalox marketer account.
     You will not be asked for a code the next time you sign in.</p>
  <p><strong>Why:</strong> our previous two-factor system did not generate a
     unique secret for each account. We have replaced it with a proper
     implementation, and the old enrolments could not be carried over safely.</p>
  <p><strong>What to do:</strong> sign in, open Settings, and enable two-factor
     authentication again. You will get a new QR code and a set of recovery
     codes — save those somewhere safe.</p>
  <p>Sorry for the inconvenience. This change makes your account safer.</p>
`;

(async () => {
  // Anyone still holding 2FA state is an affected account: the new flow stores
  // an encrypted per-user secret, and none existed before this deploy.
  const affected = await prisma.admin.findMany({
    where: {
      OR: [
        { twoFactorEnabled: true },
        { NOT: { twoFactorSecret: null } },
        { NOT: { twoFactorPendingSecret: null } },
      ],
    },
    select: { id: true, email: true, name: true, twoFactorEnabled: true },
  });

  if (affected.length === 0) {
    console.log("No accounts with legacy 2FA state. Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${affected.length} account(s) with legacy 2FA state:`);
  for (const a of affected) console.log(`  #${a.id}  ${a.email}`);

  if (DRY_RUN) {
    console.log("\n--dry-run: no changes made, no email sent.");
    await prisma.$disconnect();
    return;
  }

  const ids = affected.map((a) => a.id);

  await prisma.admin.updateMany({
    where: { id: { in: ids } },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorPendingSecret: null,
      twoFactorPendingExpiresAt: null,
      twoFactorLastUsedStep: null,
      twoFactorTempTokenId: null,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
    },
  });
  await prisma.twoFactorRecoveryCode.deleteMany({ where: { adminId: { in: ids } } });
  console.log("\nCleared legacy 2FA state.");

  let sent = 0;
  let failed = 0;
  for (const a of affected) {
    try {
      await emailService.sendEmail({
        to: a.email,
        subject: "Action needed: re-enable two-factor authentication",
        html: html(a.name),
      });
      await prisma.securityEvent.create({
        data: { adminId: a.id, event: "2fa_reset_by_migration", detail: "legacy shared-secret enrolment cleared" },
      });
      sent++;
    } catch (err) {
      failed++;
      console.error(`  email FAILED for ${a.email}: ${err.message}`);
    }
  }

  console.log(`Emails sent: ${sent}, failed: ${failed}`);
  if (failed > 0) console.log("Re-run to retry failures (state is already cleared, so it is safe).");

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
