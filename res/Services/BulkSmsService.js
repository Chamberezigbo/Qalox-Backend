const logger = require("../config/logger");

const BULKSMSNIGERIA_BASE_URL = process.env.BULKSMSNIGERIA_USE_SANDBOX === "true"
  ? "https://www.bulksmsnigeria.com/api/sandbox/v2"
  : "https://www.bulksmsnigeria.com/api/v2";

/**
 * Thin wrapper around the BulkSMSNigeria v2 API.
 * Docs: https://www.bulksmsnigeria.com/app/api/docs
 *
 * Auth is a single API token sent as `Authorization: Bearer <token>`.
 * Sender ID must be <=11 characters. Recipients are a comma-separated
 * string of international-format numbers (e.g. 234801...), not an array.
 */

const getApiToken = () => {
  const token = process.env.BULKSMSNIGERIA_API_TOKEN;
  if (!token) {
    throw new Error("BULKSMSNIGERIA_API_TOKEN must be set in the environment");
  }
  return token;
};

/**
 * Send an SMS to one or more recipients.
 * @param {Object} params
 * @param {string[]} params.recipients - full international format numbers (e.g. 234801...)
 * @param {string} params.message
 * @param {string} params.sender - max 11 characters
 * @param {string} [params.gateway] - direct-refund | direct-corporate | otp | dual-backup
 * @returns {Promise<{success: boolean, status: string, code: string, message: string, totalSent: number, cost: number, messageId: string|null, raw: object}>}
 */
const sendSms = async ({ recipients, message, sender, gateway }) => {
  const apiToken = getApiToken();

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("recipients must be a non-empty array");
  }
  if (!message || !message.trim()) {
    throw new Error("message is required");
  }
  if (!sender || sender.length > 11) {
    throw new Error("sender is required and must be at most 11 characters");
  }

  const body = {
    from: sender,
    to: recipients.join(","),
    body: message,
    ...(gateway ? { gateway } : {}),
  };

  logger.debug("[BULKSMSNIGERIA] Sending SMS", { recipientCount: recipients.length, sender });

  const response = await fetch(`${BULKSMSNIGERIA_BASE_URL}/sms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  const success = json?.status === "success";

  // The API returns two different shapes depending on recipient count: a
  // single recipient gets {id, cost, recipients: 1}, while 2+ recipients get
  // a batch shape {batch_id, total_cost, successful, failed, results: []}.
  const data = json?.data;
  const totalSent = data?.successful ?? data?.recipients;
  const cost = data?.total_cost ?? data?.cost;
  const messageId = data?.batch_id ?? data?.id ?? null;

  // Errors come in two shapes: auth/provider errors nest under `error.message`,
  // while validation errors (e.g. a malformed phone number) put a generic
  // "Validation error" at the top level and the real detail in data.errors,
  // a field-name -> message[] map.
  const validationMessages = data?.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat()
    : [];
  const errorMessage = json?.error?.message ?? validationMessages[0] ?? json?.message;

  if (!success) {
    logger.warn("[BULKSMSNIGERIA] Send failed", { status: json?.status, code: json?.code, raw: json });
  } else {
    logger.info("[BULKSMSNIGERIA] Send succeeded", { totalSent, cost });
  }

  return {
    success,
    status: json?.status,
    code: json?.code,
    message: errorMessage,
    totalSent: success ? (parseInt(totalSent, 10) || recipients.length) : 0,
    cost: parseFloat(cost) || 0,
    messageId,
    raw: json,
  };
};

/**
 * Check the current wallet balance.
 * @returns {Promise<{balance: number, raw: object}>}
 */
const checkBalance = async () => {
  const apiToken = getApiToken();
  const response = await fetch(`${BULKSMSNIGERIA_BASE_URL}/balance`, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
  });
  const json = await response.json();
  return { balance: parseFloat(json?.data?.balance) || 0, raw: json };
};

module.exports = { sendSms, checkBalance };
