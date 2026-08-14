const logger = require("../config/logger");

/**
 * Thin wrapper around the Flutterwave v3 API.
 * Docs: https://developer.flutterwave.com/v3.0/docs (NGN Bank Transfer charge,
 * Verify Transaction, Webhooks).
 *
 * v3's bank-transfer charge is a single call — no separate Customer/Payment
 * Method objects like v4. POST /charges?type=bank_transfer returns a virtual
 * account (meta.authorization) for the payer to transfer into; the
 * transaction id only becomes known once the webhook fires.
 */

const getBaseUrl = () => process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";

const getSecretKey = () => {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY must be set in the environment");
  return key;
};

const request = async (path, { method = "GET", body } = {}) => {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getSecretKey()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json();
  if (!response.ok || json.status === "error") {
    logger.warn("[FLUTTERWAVE] Request failed", { path, status: response.status, raw: json });
    const err = new Error(json?.message || `Flutterwave request to ${path} failed`);
    err.flwResponse = json;
    throw err;
  }
  return json;
};

/**
 * Initiates an NGN bank-transfer charge. Returns the virtual account the
 * payer should transfer into. Flutterwave doesn't return a transaction id at
 * this point for bank_transfer charges — that only arrives via webhook.
 * @param {{amount: number, email: string, fullname: string, phoneNumber?: string, reference: string, narration?: string}} params
 */
const createBankTransferCharge = async ({ amount, email, fullname, phoneNumber, reference, narration }) => {
  const json = await request("/charges?type=bank_transfer", {
    method: "POST",
    body: {
      tx_ref: reference,
      amount: String(amount),
      currency: "NGN",
      email,
      fullname,
      phone_number: phoneNumber,
      narration,
    },
  });

  const auth = json.meta?.authorization;
  logger.info("[FLUTTERWAVE] Bank transfer charge initiated", { reference, transferReference: auth?.transfer_reference });

  return {
    bankTransfer: auth
      ? {
          account_number: auth.transfer_account,
          account_bank_name: auth.transfer_bank,
          account_expiration_datetime: auth.account_expiration,
          note: auth.transfer_note,
        }
      : null,
    transferReference: auth?.transfer_reference || null,
    raw: json,
  };
};

/**
 * Re-verifies a transaction server-side rather than trusting the webhook
 * payload alone, per Flutterwave's own recommendation.
 * @param {number|string} transactionId - Flutterwave's data.id from the webhook payload
 */
const verifyTransaction = async (transactionId) => {
  const json = await request(`/transactions/${transactionId}/verify`);
  return json.data;
};

/**
 * Verify an incoming webhook's `verif-hash` header — a plain string
 * comparison against the secret hash configured in the Flutterwave dashboard
 * (Settings > Webhooks), NOT an HMAC (that's v4's scheme, not v3's).
 * @param {string} signatureHeader - value of the verif-hash header
 * @returns {boolean}
 */
const verifyWebhookSignature = (signatureHeader) => {
  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash) throw new Error("FLW_SECRET_HASH must be set in the environment");
  return !!signatureHeader && signatureHeader === secretHash;
};

/**
 * Live list of Nigerian banks with their NIP codes.
 * GET /banks/NG -> { data: [ { id, code, name } ] }
 *
 * Fetched rather than hardcoded because the code is what a transfer is
 * actually routed on: a stale or wrong code sends a payout to the wrong
 * institution or fails outright.
 * @returns {Promise<Array<{code: string, name: string}>>}
 */
const listBanks = async () => {
  const json = await request("/banks/NG");
  const banks = (json.data || [])
    .map((b) => ({ code: String(b.code), name: b.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  logger.info("[FLUTTERWAVE] Bank list retrieved", { count: banks.length });
  return banks;
};

/**
 * Resolve a bank account number to its registered account name.
 * POST /accounts/resolve -> { data: { account_number, account_name } }
 *
 * @param {{accountNumber: string, bankCode: string}} params
 * @returns {Promise<{accountNumber: string, accountName: string}>}
 * @throws when Flutterwave cannot resolve the account — callers MUST treat a
 *   throw as "not verified" and never fall back to reporting success.
 */
const resolveAccount = async ({ accountNumber, bankCode }) => {
  const json = await request("/accounts/resolve", {
    method: "POST",
    body: { account_number: accountNumber, account_bank: bankCode },
  });

  return {
    accountNumber: json.data?.account_number || accountNumber,
    accountName: json.data?.account_name,
  };
};

module.exports = {
  createBankTransferCharge,
  verifyTransaction,
  verifyWebhookSignature,
  listBanks,
  resolveAccount,
};
