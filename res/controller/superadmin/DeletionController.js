const fs = require("fs");
const path = require("path");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const {
  DeletionBlocked,
  DeletionTargetNotFound,
  planTokenDeletion,
  planAdminDeletion,
  planMarketerDeletion,
  deleteToken,
  deleteAdmin,
  deleteMarketer,
} = require("../../Services/superAdminDeletion");

/**
 * Super Admin deletion of tokens, school admins and marketers.
 *
 * Mounted on both auth paths: the JWT routes (req.admin) and the service-key
 * routes (req.user, absent for pure service calls). The rules themselves live in
 * Services/superAdminDeletion.ts; this file only parses the request, writes the
 * audit line and shapes the response.
 */

const KYC_DIR = path.join(__dirname, "..", "..", "uploads-private", "kyc");

/** Who is doing this, for the log. After a delete the row is gone, so the log line is the only record. */
const actorOf = (req) => ({
  actorId: req.admin?.id ?? req.user?.id ?? null,
  actorEmail: req.user?.email ?? null,
  actorRole: req.admin?.role ?? req.user?.role ?? (req.service?.type ? `service:${req.service.type}` : null),
});

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Turns the service's expected failures into responses; anything else goes to the error middleware. */
const respondToFailure = (error, res, next) => {
  if (error instanceof DeletionBlocked) {
    return res.status(409).json({ success: false, message: error.message, code: error.code, data: error.plan });
  }
  if (error instanceof DeletionTargetNotFound) {
    return res.status(404).json({ success: false, message: error.message, code: error.code });
  }
  return next(error);
};

const badId = (res) => res.status(400).json({ success: false, message: "Invalid ID", code: "INVALID_ID" });

const requireConfirmation = (req, res) => {
  if (req.body?.confirmDeletion === true) return true;
  res.status(400).json({
    success: false,
    message: "Deletion requires confirmDeletion: true",
    code: "DELETION_NOT_CONFIRMED",
  });
  return false;
};

/** Builds a preview handler and a delete handler for one kind of target. */
const handlersFor = ({ name, plan, remove }) => ({
  preview: async (req, res, next) => {
    try {
      const id = parseId(req);
      if (!id) return badId(res);
      const result = await plan(req, id);
      res.status(200).json({ success: true, message: `${name} deletion preview`, data: result });
    } catch (error) {
      respondToFailure(error, res, next);
    }
  },
  remove: async (req, res, next) => {
    try {
      const id = parseId(req);
      if (!id) return badId(res);
      if (!requireConfirmation(req, res)) return;

      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
      logger.info(`[DELETE_${name.toUpperCase()}] Starting deletion`, { id, reason, ...actorOf(req) });

      const result = await remove(req, id);

      logger.info(`[DELETE_${name.toUpperCase()}] Deleted`, {
        id,
        label: result.plan.label,
        willRemove: result.plan.willRemove,
        reason,
        ...actorOf(req),
      });
      res.status(200).json({ success: true, message: `${name} deleted successfully`, data: result.plan });
    } catch (error) {
      respondToFailure(error, res, next);
    }
  },
});

const tokens = handlersFor({
  name: "Token",
  plan: (req, id) => planTokenDeletion(prisma, id),
  remove: async (req, id) => ({ plan: await deleteToken(prisma, id) }),
});

const admins = handlersFor({
  name: "Admin",
  plan: (req, id) => planAdminDeletion(prisma, id, actorOf(req).actorId),
  remove: async (req, id) => ({ plan: await deleteAdmin(prisma, id, actorOf(req).actorId) }),
});

const marketers = handlersFor({
  name: "Marketer",
  plan: (req, id) => planMarketerDeletion(prisma, id),
  remove: async (req, id) => {
    const { plan, documentFiles } = await deleteMarketer(prisma, id);
    // After the commit: a file cannot be rolled back, and a stray one is harmless.
    for (const file of documentFiles) {
      try {
        await fs.promises.unlink(path.join(KYC_DIR, path.basename(file)));
      } catch (error) {
        logger.warn("[DELETE_MARKETER] Could not remove stored document", { file, error: error.message });
      }
    }
    return { plan };
  },
});

module.exports = {
  previewTokenDeletion: tokens.preview,
  deleteTokenPermanently: tokens.remove,
  previewAdminDeletion: admins.preview,
  deleteSchoolAdmin: admins.remove,
  previewMarketerDeletion: marketers.preview,
  deleteMarketerAccount: marketers.remove,
};
