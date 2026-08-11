const { Resend } = require("resend");
const logger = require("../config/logger");

/**
 * Thin wrapper around the Resend email API.
 * Docs: https://resend.com/docs/send-with-nodejs
 */

let client = null;
const getClient = () => {
  if (client) return client;
  const apiKey = process.env.ResenderAPI_KEY;
  if (!apiKey) throw new Error("ResenderAPI_KEY must be set in the environment");
  client = new Resend(apiKey);
  return client;
};

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || "Qalox <onboarding@resend.dev>";

/**
 * Send the same email individually to each recipient (not bcc/cc — recipients
 * are separate schools and shouldn't see each other's addresses).
 * @param {{recipients: string[], subject: string, html: string}} params
 * @returns {Promise<{sent: number, failed: number, errors: {email: string, message: string}[]}>}
 */
const sendBulkEmail = async ({ recipients, subject, html }) => {
  const resend = getClient();

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("recipients must be a non-empty array");
  }

  const results = await Promise.allSettled(
    recipients.map((to) => resend.emails.send({ from: FROM_ADDRESS, to, subject, html }))
  );

  const errors = [];
  let sent = 0;

  results.forEach((result, i) => {
    if (result.status === "fulfilled" && !result.value.error) {
      sent += 1;
    } else {
      const message = result.status === "fulfilled" ? result.value.error?.message : result.reason?.message;
      errors.push({ email: recipients[i], message: message || "Unknown error" });
    }
  });

  logger.info("[EMAIL] Bulk send complete", { total: recipients.length, sent, failed: errors.length });
  if (errors.length > 0) {
    logger.warn("[EMAIL] Some sends failed", { errors });
  }

  return { sent, failed: errors.length, errors };
};

/**
 * Send a single email.
 * @param {{to: string, subject: string, html: string}} params
 */
const sendEmail = async ({ to, subject, html }) => {
  const resend = getClient();
  const { data, error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });

  if (error) {
    logger.warn("[EMAIL] Send failed", { to, error: error.message });
    throw new Error(error.message || "Failed to send email");
  }

  logger.info("[EMAIL] Sent", { to, id: data?.id });
  return data;
};

module.exports = { sendBulkEmail, sendEmail };
