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
 * Initiates a Standard (hosted) Checkout — a single call returns a payment
 * link. Flutterwave's own hosted page then offers every payment method
 * enabled on the account (card, bank transfer, USSD, mobile money, etc.),
 * handling all card 3DS/OTP complexity itself; the browser is redirected
 * back to redirectUrl afterward with ?status=&tx_ref=&transaction_id=. Used
 * for school subscription payments — NOT the same charge type as
 * createBankTransferCharge above, which parent/student fee payments used to
 * use before that flow moved to direct-bank-transfer-only (see
 * StudentFeeService.ts) and is now reserved for this admin-billing flow.
 * @param {{amount: number, email: string, fullname: string, phoneNumber?: string, reference: string, redirectUrl: string, title?: string, description?: string}} params
 * @returns {Promise<{checkoutUrl: string, raw: object}>}
 */
const createStandardCheckout = async ({ amount, email, fullname, phoneNumber, reference, redirectUrl, title, description, subaccounts, meta }) => {
  const json = await request("/payments", {
    method: "POST",
    body: {
      tx_ref: reference,
      amount: String(amount),
      currency: "NGN",
      redirect_url: redirectUrl,
      customer: { email, phonenumber: phoneNumber, name: fullname },
      customizations: { title: title || "Qalox Subscription", description: description || "Qalox subscription payment" },
      // Split payment: which subaccount(s) receive what (see createSubaccount). Omitted for subscriptions.
      ...(subaccounts ? { subaccounts } : {}),
      ...(meta ? { meta } : {}),
    },
  });

  logger.info("[FLUTTERWAVE] Standard checkout initiated", { reference });

  return { checkoutUrl: json.data?.link || null, raw: json };
};

/**
 * Creates a Flutterwave subaccount: the school's own settlement account. A payment that names it in
 * `subaccounts` has its split routed there, and Flutterwave settles that share to the school.
 * POST /subaccounts -> { data: { id, subaccount_id: "RS_...", ... } }
 *
 * The default split here (a flat 0) is never used: every fee payment states its own split
 * (`flat_subaccount`: the school gets exactly the fee).
 * @param {{ bankCode: string, accountNumber: string, businessName: string, email?: string, phoneNumber?: string }} params
 * @returns {Promise<{ subaccountId: string }>}
 */
const createSubaccount = async ({ bankCode, accountNumber, businessName, email, phoneNumber }) => {
  const json = await request("/subaccounts", {
    method: "POST",
    body: {
      account_bank: bankCode,
      account_number: accountNumber,
      business_name: businessName,
      business_email: email,
      business_mobile: phoneNumber,
      country: "NG",
      split_type: "flat",
      split_value: 0,
    },
  });
  const subaccountId = json.data?.subaccount_id;
  if (!subaccountId) throw new Error("Flutterwave did not return a subaccount id");
  logger.info("[FLUTTERWAVE] Subaccount created", { subaccountId });
  return { subaccountId };
};

/**
 * Looks a transaction up by OUR reference (tx_ref), for the page a payer returns to, where the
 * webhook may not have arrived yet. Resolves null while Flutterwave has no such transaction.
 */
const verifyByReference = async (reference) => {
  try {
    const json = await request(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    return json.data || null;
  } catch (error) {
    if (/no transaction/i.test(error.message || "")) return null;
    throw error;
  }
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
  createStandardCheckout,
  createSubaccount,
  verifyByReference,
  verifyTransaction,
  verifyWebhookSignature,
  listBanks,
  resolveAccount,
};
