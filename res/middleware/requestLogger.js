const crypto = require("crypto");
const logger = require("../config/logger");
const requestContext = require("../util/requestContext");

// A caller (or a proxy) may send its own id; only a sane one is trusted.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

// Middleware to log all incoming requests and responses
const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  const incoming = req.headers["x-request-id"];
  const requestId = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.requestId = requestId;
  // Lets a user (or support) quote the id of a failed request.
  res.setHeader("X-Request-Id", requestId);

  // Log incoming request
  logger.info(`[${requestId}] Incoming Request`, {
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers["user-agent"],
    timestamp: new Date().toISOString(),
  });

  // Capture the original res.send
  const originalSend = res.send;

  res.send = function (data) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log response
    const logLevel = statusCode >= 400 ? "warn" : "info";
    logger[logLevel](`[${requestId}] Response`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: statusCode,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });

    // Call the original send method
    return originalSend.call(this, data);
  };

  // Everything that runs for this request (any file, any await) sees the same requestId.
  requestContext.run({ requestId }, next);
};

module.exports = requestLogger;
