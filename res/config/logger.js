const winston = require("winston");
const path = require("path");
const requestContext = require("../util/requestContext");

const isProduction = process.env.NODE_ENV === "production";

// Values under these keys are never written to a log (here or in the error table).
const SENSITIVE_KEY = /pass(word)?|token|authorization|secret|otp|cookie|api[-_]?key|credential/i;

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

// Adds the current request's id (and redacts secrets) to every line, from any file.
const withContext = winston.format((info) => {
  const ctx = requestContext.get();
  if (ctx?.requestId && !info.requestId) info.requestId = ctx.requestId;
  for (const key of Object.keys(info)) {
    if (key !== "level" && key !== "message" && key !== "stack" && info[key] && typeof info[key] === "object") {
      info[key] = redact(info[key]);
    }
  }
  return info;
});

// Custom color format for terminal
const colors = {
  error: '\x1b[31m',    // Red
  warn: '\x1b[33m',     // Yellow
  info: '\x1b[36m',     // Cyan
  debug: '\x1b[35m',    // Magenta
  http: '\x1b[34m',     // Blue
  success: '\x1b[32m',  // Green
  reset: '\x1b[0m'      // Reset
};

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    withContext(),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: "qalox-backend" },
  transports: [
    // Console transport - for terminal monitoring
    new winston.transports.Console({
      // Production (Railway): one JSON object per line, so logs can be searched by field
      // (level, requestId, schoolId...). Development keeps the coloured, readable output.
      format: isProduction
        ? winston.format.combine(winston.format.timestamp(), winston.format.json())
        : winston.format.combine(
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const color = colors[level] || colors.reset;
          const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : '';
          return `${color}[${timestamp}] ${level.toUpperCase()}${colors.reset}: ${message} ${metaStr}`;
        })
      ),
    }),
    // Error file transport
    new winston.transports.File({
      filename: path.join(__dirname, "error.log"),
      level: "error",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
    // Combined log file
    new winston.transports.File({
      filename: path.join(__dirname, "combined.log"),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
  ],
});

// Railway's disk is wiped on every deploy, so log files there would only cost I/O. Errors are
// kept in the database instead (util/errorTracker.js); the files stay for local development.
if (isProduction) {
  logger.transports
    .filter((t) => t instanceof winston.transports.File)
    .forEach((t) => logger.remove(t));
}

module.exports = logger;
module.exports.redact = redact;
