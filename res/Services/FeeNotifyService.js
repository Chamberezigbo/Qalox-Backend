const prisma = require("../util/prisma");
const logger = require("../config/logger");
const { sendEmail } = require("./EmailService");
const { brandedEmail } = require("../util/emailTemplate");
const { resolveBranding } = require("../util/campusBranding");
const { schoolMediaUrl } = require("../controller/public/publicController");

/**
 * Tells parents about a fee that was just set up (a PTA levy, an urgent payment, next term's fees).
 * Every parent with a linked account gets an in-app alert; every guardian email on file gets an email.
 *
 * Runs AFTER the fee is saved and can never undo it: a failure here is logged, not thrown. The emails
 * go out in the background (a whole school can be hundreds) so saving the fee does not wait for them.
 */

const MAX_NOTIFIED = 400;
const CONCURRENCY = 5;

const naira = (n) => `₦${Number(n).toLocaleString("en-NG")}`;
const dateText = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The sentence a parent reads, shared by the alert and the email. */
function describeFee({ title, studentName, total, dueDate }) {
  return `${title} for ${studentName}: ${naira(total)}${dueDate ? `, due ${dateText(dueDate)}` : ""}.`;
}

/**
 * @param {{ schoolId: number, studentFeeIds: number[] }} input the invoices that were just created
 * @returns {Promise<{ considered: number, alerts: number, emailsQueued: number, noEmail: number, skipped: number }>}
 */
async function notifyNewFees({ schoolId, studentFeeIds }) {
  const summary = { considered: 0, alerts: 0, emailsQueued: 0, noEmail: 0, skipped: 0 };
  try {
    const ids = studentFeeIds.slice(0, MAX_NOTIFIED);
    summary.skipped = Math.max(0, studentFeeIds.length - ids.length);
    if (ids.length === 0) return summary;

    const invoices = await prisma.studentFee.findMany({
      where: { id: { in: ids }, schoolId },
      select: {
        id: true, totalFee: true,
        student: { select: { id: true, name: true, surname: true, parentId: true, guardianEmail: true, campusId: true } },
        feeStructure: { select: { title: true, dueDate: true } },
      },
    });
    summary.considered = invoices.length;

    const alerts = invoices.filter((i) => i.student.parentId).map((i) => ({
      parentId: i.student.parentId,
      studentId: i.student.id,
      type: "fee_reminder",
      message: `New fee: ${describeFee({ title: i.feeStructure.title, studentName: i.student.name, total: i.totalFee, dueDate: i.feeStructure.dueDate })}`,
    }));
    if (alerts.length > 0) {
      await prisma.parentAlert.createMany({ data: alerts });
      summary.alerts = alerts.length;
    }

    const withEmail = invoices.filter((i) => i.student.guardianEmail);
    summary.noEmail = invoices.length - withEmail.length;
    summary.emailsQueued = withEmail.length;
    if (withEmail.length > 0) {
      // Not awaited: see the note at the top of this file.
      sendEmails(schoolId, withEmail).catch((error) => logger.error("[FEE_NOTIFY] Email run failed", { reason: error.message }));
    }
  } catch (error) {
    logger.error("[FEE_NOTIFY] Could not notify parents (the fee is saved)", { schoolId, reason: error.message });
  }
  return summary;
}

async function sendEmails(schoolId, invoices) {
  const branding = await resolveBranding(prisma, { schoolId, campusId: invoices[0].student.campusId ?? null });
  const logoUrl = await schoolMediaUrl(branding?.logoUrl);
  const portal = (process.env.SCHOOL_PORTAL_URL || "").replace(/\/+$/, "");

  let sent = 0;
  let failed = 0;
  const queue = [...invoices];
  const worker = async () => {
    while (queue.length > 0) {
      const invoice = queue.shift();
      const text = describeFee({ title: invoice.feeStructure.title, studentName: invoice.student.name, total: invoice.totalFee, dueDate: invoice.feeStructure.dueDate });
      try {
        await sendEmail({
          to: invoice.student.guardianEmail,
          subject: `New fee: ${invoice.feeStructure.title}`,
          html: brandedEmail({
            schoolName: branding?.name ?? "Your School",
            logoUrl,
            brandColor: branding?.brandColor,
            title: "A new fee has been added",
            bodyHtml: `<p style="margin:0 0 12px;">${text}</p>
              <p style="margin:0;color:#555;">You can view it and pay securely in the school app${portal ? `: <a href="${portal}">${portal}</a>` : "."}</p>`,
          }),
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        logger.warn("[FEE_NOTIFY] Email not sent", { studentFeeId: invoice.id, reason: error.message });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  logger.info("[FEE_NOTIFY] Fee emails finished", { schoolId, sent, failed });
}

module.exports = { notifyNewFees, describeFee, MAX_NOTIFIED };
