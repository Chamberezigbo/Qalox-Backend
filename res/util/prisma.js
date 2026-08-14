const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient();

const toDateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const isDecimal = (v) => Prisma?.Decimal && v instanceof Prisma.Decimal;

function transform(value) {
  if (value == null) return value;

  // Preserve primitives
  if (typeof value !== "object") return value;

  // Convert Decimal globally
  if (isDecimal(value)) return value.toNumber();

  // Preserve Date instances (handled key-aware below)
  if (value instanceof Date) return value;

  // Arrays
  if (Array.isArray(value)) return value.map(transform);

  // Plain object: transform entries
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "createdAt" && v instanceof Date) {
      out[k] = toDateOnly(v);
    } else if (isDecimal(v)) {
      out[k] = v.toNumber();
    } else {
      out[k] = transform(v);
    }
  }
  return out;
}

prisma.$use(async (params, next) => {
  const result = await next(params);
  return transform(result);
});

/**
 * Retry transient connection failures.
 *
 * In local development the database is reached over Railway's public TCP proxy,
 * which silently drops pooled connections that have been idle. The next query to
 * borrow a dead connection fails with P1001 ("Can't reach database server") even
 * though the server is perfectly healthy — a fresh connection succeeds
 * immediately. Deployed on Railway this is largely moot: the app uses the
 * internal network, where connections are not proxied.
 *
 * Only connection-level errors are retried, and every one of them means the
 * query never reached the server:
 *   P1001 — could not reach the database
 *   P1017 — server closed the connection
 *   P2024 — timed out obtaining a connection from the pool
 * A query that failed for any other reason (constraint violation, bad input,
 * timeout mid-statement) is rethrown untouched, so a write is never silently
 * applied twice.
 *
 * Registered after the transform middleware, so it wraps the raw query and the
 * result is transformed once, on the attempt that actually succeeds.
 */
const RETRYABLE_CONNECTION_ERRORS = new Set(["P1001", "P1017", "P2024"]);
const MAX_RETRIES = 2;

prisma.$use(async (params, next) => {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await next(params);
    } catch (err) {
      const code = err?.errorCode ?? err?.code;
      if (!RETRYABLE_CONNECTION_ERRORS.has(code)) throw err;

      lastError = err;
      if (attempt === MAX_RETRIES) break;

      // Short linear backoff — a stale connection is replaced on the next
      // borrow, so this is about yielding, not waiting out an outage.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError;
});

module.exports = prisma;
