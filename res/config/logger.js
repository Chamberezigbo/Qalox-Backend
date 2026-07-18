const winston = require("winston");
const path = require("path");

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
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: "qalox-backend" },
  transports: [
    // Console transport - for terminal monitoring
    new winston.transports.Console({
      format: winston.format.combine(
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

module.exports = logger;
