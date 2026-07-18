const logger = require("../config/logger");

// Middleware to log all incoming requests and responses
const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);

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

  next();
};

module.exports = requestLogger;
