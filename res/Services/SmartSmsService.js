const logger = require("../config/logger");

const SMARTSMS_BASE_URL = "https://www.smartsms.ng/api";

/**
 * Thin wrapper around the SmartSMS Nigeria JSON API.
 * Docs: https://www.smartsms.ng/pages/json-api
 *
 * Auth is username (account email) + apikey, both sent in the request body —
 * not headers. Sender ID must be <=11 alphanumeric chars (or <=14 numeric).
 */

const getCredentials = () => {
  const username = process.env.SMARTSMS_USERNAME;
  const apikey = process.env.SMARTSMS_API_KEY;
  if (!username || !apikey) {
    throw new Error("SMARTSMS_USERNAME and SMARTSMS_API_KEY must be set in the environment");
  }
  return { username, apikey };
};

/**
 * Send an SMS to one or more recipients.
 * @param {Object} params
 * @param {{msidn: string, msgid?: string}[]} params.recipients - full international format numbers (e.g. 234801...)
 * @param {string} params.message
 * @param {string} params.sender - max 11 alphanumeric chars
 * @param {boolean} [params.flash]
 * @returns {Promise<{success: boolean, status: string, totalSent: number, cost: number, raw: object}>}
 */
const sendSms = async ({ recipients, message, sender, flash = false }) => {
  const { username, apikey } = getCredentials();

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
    SMS: {
      auth: { username, apikey },
      message: { sender, messagetext: message, flash: flash ? "1" : "0" },
      recipients: {
        gsm: recipients.map((r) => ({ msidn: r.msidn, msgid: r.msgid })),
      },
    },
  };

  logger.debug("[SMARTSMS] Sending SMS", { recipientCount: recipients.length, sender });

  const response = await fetch(`${SMARTSMS_BASE_URL}/sendsms.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  const status = json?.response?.status;
  const success = status === "SUCCESS";

  if (!success) {
    logger.warn("[SMARTSMS] Send failed", { status, raw: json });
  } else {
    logger.info("[SMARTSMS] Send succeeded", { totalSent: json.response.totalsent, cost: json.response.cost });
  }

  return {
    success,
    status,
    totalSent: parseInt(json?.response?.totalsent, 10) || 0,
    cost: parseInt(json?.response?.cost, 10) || 0,
    raw: json,
  };
};

/**
 * Check the current SMS credit balance.
 * @returns {Promise<{balance: number, raw: object}>}
 */
const checkBalance = async () => {
  const { username, apikey } = getCredentials();
  const response = await fetch(`${SMARTSMS_BASE_URL}/balance/${encodeURIComponent(username)}/${encodeURIComponent(apikey)}`);
  // The endpoint returns a bare number in the response body (e.g. "2.00"), not a JSON object
  const text = await response.text();
  return { balance: parseFloat(text) || 0, raw: text };
};

module.exports = { sendSms, checkBalance };
