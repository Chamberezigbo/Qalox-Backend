const crypto = require("crypto");
const prisma = require("./prisma");
const logger = require("../config/logger");
const requestContext = require("./requestContext");

/**
 * Keeps server errors where they survive a deploy.
 *
 * Railway only shows recent logs, so every 5xx and every crash is also written to the
 * `error_logs` table with the request, user and school it happened to, and a fingerprint
 * that groups the same bug together however many times it fires. Saving never throws:
 * if the database is the thing that is down, the error is still in the console log.
 */

const MESSAGE_MAX = 2000;
const STACK_MAX = 8000;
// The same bug firing in a loop would fill the table; one row per fingerprint per window.
const THROTTLE_MS = 30 * 1000;
const throttle = new Map();

const clip = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value);

/** Numbers, ids and quoted values vary between occurrences of one bug, so they are dropped. */
function normalizeMessage(message) {
  return String(message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/(["'`]).*?\1/g, "<value>")
    .replace(/\d+/g, "<n>")
    .slice(0, 300);
}

/** The first line of the stack that is this app's own code (not node_modules or node internals). */
function firstAppFrame(stack) {
  if (typeof stack !== "string") return "";
  const line = stack.split("\n").find((l) => /\s+at /.test(l) && !l.includes("node_modules") && !l.includes("node:"));
  if (!line) return "";
  return line.trim().replace(/^at\s+/, "").replace(/:\d+:\d+\)?$/, "").replace(/^.*\/(res\/|app\.)/, "$1");
}

/** Same bug => same fingerprint: error type + message shape + where in our code it came from. */
function fingerprint(err) {
  const name = err?.name || "Error";
  return crypto
    .createHash("sha1")
    .update([name, normalizeMessage(err?.message), firstAppFrame(err?.stack)].join("|"))
    .digest("hex");
}

/** Who the request belongs to, from whatever the auth middleware attached. */
function whoIs(req) {
  if (!req) return {};
  if (req.staffId) return { userType: "staff", userId: Number(req.staffId) };
  if (req.studentId) return { userType: "student", userId: Number(req.studentId) };
  if (req.parentId) return { userType: "parent", userId: Number(req.parentId) };
  const admin = req.user?.id ? req.user : req.admin?.id ? req.admin : null;
  if (admin) return { userType: String(admin.role || "admin").slice(0, 20), userId: Number(admin.id) };
  return {};
}

/**
 * The path with ids swapped for ":id" ("/api/admin/classes/5" -> "/api/admin/classes/:id"), so every
 * request to one route reads the same. (Express's own route pattern is not available this late: by
 * the time the error handler runs, the router's base path has been reset.)
 */
function routeOf(req) {
  if (!req) return null;
  const path = (req.originalUrl || req.url || "").split("?")[0];
  const generic = path
    .split("/")
    .map((part) => (/^\d+$/.test(part) || /^[0-9a-f]{16,}$/i.test(part) || /^[0-9a-f-]{32,36}$/i.test(part) ? ":id" : part))
    .join("/");
  return clip(generic, 255);
}

/**
 * Records an error. Call it for anything that should be investigated later.
 * @param {unknown} err
 * @param {{ req?: import("express").Request, source?: string, statusCode?: number, extra?: object }} [options]
 * @returns {Promise<string | null>} the request id it was recorded under
 */
async function captureError(err, { req, source = "request", statusCode, extra } = {}) {
  const requestId = requestContext.get()?.requestId ?? req?.requestId ?? null;
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    const key = fingerprint(error);

    const last = throttle.get(key);
    const now = Date.now();
    if (last && now - last.at < THROTTLE_MS) {
      last.suppressed += 1;
      return requestId;
    }
    const suppressed = last?.suppressed ?? 0;
    throttle.set(key, { at: now, suppressed: 0 });
    if (throttle.size > 500) throttle.clear();

    await prisma.errorLog.create({
      data: {
        fingerprint: key,
        name: clip(error.name || "Error", 100),
        message: clip((error.message || "(no message)").trim(), MESSAGE_MAX),
        stack: clip(error.stack, STACK_MAX) ?? null,
        source,
        statusCode: statusCode ?? null,
        method: req?.method ? clip(req.method, 10) : null,
        route: routeOf(req),
        requestId: clip(requestId, 64) ?? null,
        schoolId: Number(req?.schoolId) || null,
        userAgent: req?.headers?.["user-agent"] ? clip(String(req.headers["user-agent"]), 255) : null,
        ...whoIs(req),
        extra: suppressed > 0 || extra ? { ...(extra ?? {}), ...(suppressed > 0 ? { suppressedSincePrevious: suppressed } : {}) } : undefined,
      },
    });
  } catch (saveError) {
    // Never let error tracking cause an error of its own.
    logger.warn("[ERROR_TRACKER] Could not save error to the database", { reason: saveError?.message });
  }
  return requestId;
}

/** Deletes records older than `days` so the table does not grow forever. */
async function purgeOldErrors(days = 90) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await prisma.errorLog.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    if (count > 0) logger.info(`[ERROR_TRACKER] Removed ${count} error record(s) older than ${days} days`);
  } catch (error) {
    logger.warn("[ERROR_TRACKER] Could not clean up old errors", { reason: error?.message });
  }
}

module.exports = { captureError, purgeOldErrors, fingerprint, normalizeMessage, firstAppFrame, whoIs, routeOf };
