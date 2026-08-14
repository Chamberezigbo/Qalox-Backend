const { verifyDocumentSignature } = require("../util/documentUrlSignature");
const { serviceAuth, requirePlatformSuperAdmin } = require("./serviceAuth");
const logger = require("../config/logger");

/**
 * Authorises a marketer-document fetch by EITHER a valid short-lived signature
 * in the query string OR the normal header auth.
 *
 * Both paths are needed:
 *   - The signature path serves the browser directly — <img src>, <iframe src>
 *     and target="_blank" links send no headers and cannot be made to.
 *   - The header path keeps working for anything calling through an API client
 *     (scripts, the portal's own fetch wrapper, curl in the acceptance checks).
 *
 * The signature is checked first because it is the cheap, self-contained test:
 * an HMAC over values already in the URL, no database or JWT work.
 */
const signedDocumentAccess = (req, res, next) => {
  const marketerId = parseInt(req.params.id, 10);
  const documentId = parseInt(req.params.documentId, 10);

  // The signature normally arrives as path segments, because the URL has to
  // END in the file extension for the portal's renderer regexes to match — a
  // query string after ".jpg" breaks them. The query-string form is still
  // accepted so hand-written links and older callers keep working.
  const exp = req.params.exp ?? req.query.exp;
  const sig = req.params.sig ?? req.query.sig;

  // Only attempt signature auth when the caller actually presented one —
  // otherwise every header-authenticated request would log a failed check.
  if (sig || exp) {
    const result = verifyDocumentSignature(marketerId, documentId, exp, sig);

    if (result.valid) {
      req.signedDocumentAccess = true;
      return next();
    }

    // A bad signature is not a reason to fall through to header auth — the
    // caller made a claim and it failed. Falling through would turn a forgery
    // attempt into a silent 401-for-a-different-reason and hide it from logs.
    logger.warn(`[DOC_SIGNED_ACCESS] Rejected signed URL`, {
      marketerId,
      documentId,
      reason: result.reason,
      ip: req.ip,
    });

    // EXPIRED is separated out so the portal can tell the operator "reload the
    // page" instead of "you are not allowed". Everything else is deliberately
    // reported as one indistinguishable failure.
    const expired = result.reason === "EXPIRED";

    return res.status(401).json({
      success: false,
      message: expired
        ? "This document link has expired. Reload the marketers list to get a fresh one."
        : "Invalid document link",
      code: expired ? "DOCUMENT_LINK_EXPIRED" : "DOCUMENT_LINK_INVALID",
      data: null,
    });
  }

  // No signature presented — fall back to the standard Super Admin gate.
  return serviceAuth(req, res, (err) => {
    if (err) return next(err);
    return requirePlatformSuperAdmin(req, res, next);
  });
};

module.exports = { signedDocumentAccess };
