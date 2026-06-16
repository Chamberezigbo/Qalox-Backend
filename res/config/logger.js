const winston = require("winston");
const path = require("path");

const logger = winston.createLogger({
  level: "error", //log only errors messages
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, "error.log"),
      level: "error",
    }),
  ],
});

module.exports = logger;
