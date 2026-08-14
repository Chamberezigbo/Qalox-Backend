require('dotenv').config();

const express = require("express");
const cors = require("cors");

const prisma = require("./res/util/prisma");
const adminRoutes = require("./res/routes/admin/admin");
const schoolSetupRoutes = require("./res/routes/school");
const classRoutes = require("./res/routes/class");
const systemAdmin = require("./res/routes/system-admin/generateToken");
const studentRoutes = require("./res/routes/student");
const teacherRoutes = require("./res/routes/teacher");
const parentRoutes = require("./res/routes/parent");
const setupRoutes = require("./res/routes/setup");
const superAdminRoutes = require("./res/routes/superadmin/superadmin");
const { errorMiddleware } = require("./res/middleware/error");
const publicRoutes = require("./res/routes/public");
const publicAPIRoutes = require("./res/routes/publicAPI");
const webhookRoutes = require("./res/routes/webhooks");
const { notFound } = require("./res/middleware/404");
const studentDash = require("./res/routes/studentDashboard");
const requestLogger = require("./res/middleware/requestLogger");
const logger = require("./res/config/logger");
const documentationMiddleware = require("./res/middleware/documentation");

const app = express();

// Enable CORS with configurable origins from .env
const corsCredentials = process.env.CORS_CREDENTIALS === "true";

// Deliberately NOT defaulted to "development": an unset NODE_ENV must fail
// closed onto the CORS_ORIGIN allowlist, never onto the permissive localhost
// branch. The startup banner below reports this same value, so what is logged
// and what CORS actually enforces can no longer disagree.
const NODE_ENV = process.env.NODE_ENV || "";
const isDevelopment = NODE_ENV === "development";

const corsOrigin = (origin, callback) => {
  if (isDevelopment) {
    // Allow all localhost variants in development
    if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
      callback(null, true);
    } else {
      callback(new Error(`Not allowed by CORS: ${origin} (NODE_ENV=development allows localhost only)`));
    }
  } else {
    // In production, use specific origins from .env
    const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map(o => o.trim()) || [];
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error(`Not allowed by CORS: ${origin} (allowed: ${allowedOrigins.join(", ") || "none configured"})`));
    }
  }
};

app.use(cors({
  origin: corsOrigin,
  credentials: corsCredentials,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-service-key"],
}));

// Parse JSON bodies. `verify` stashes the raw request body bytes on req.rawBody
// before parsing — needed by webhook handlers (e.g. Flutterwave) that must HMAC
// the exact raw payload, which is no longer available once JSON parsing runs.
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));

// Request logging middleware - logs all incoming requests and responses
app.use(requestLogger);

// Documentation middleware - Swagger UI at /docs (enable with ENABLE_DOCS=true)
documentationMiddleware(app);

// Log server startup
logger.info("✅ Qalox Backend Server Starting", {
  environment: NODE_ENV || "(NODE_ENV not set — CORS uses the CORS_ORIGIN allowlist)",
  corsMode: isDevelopment
    ? "development: localhost origins allowed"
    : `allowlist: ${process.env.CORS_ORIGIN || "none configured"}`,
  port: process.env.PORT || 3000,
  docsEnabled: process.env.ENABLE_DOCS === "true" ? "✅ Yes (/docs)" : "❌ No (set ENABLE_DOCS=true)",
});

// Static files //
const path = require("path");
app.use("/api/uploads", express.static(path.join(__dirname, "res/uploads")));

// Routes
app.use("/api/admin", adminRoutes);
app.use("/api/school", schoolSetupRoutes);
app.use("/api/class", classRoutes);
app.use("/api/system-admin", systemAdmin);
app.use("/api/student", studentRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/api/parent", parentRoutes);
app.use("/api/setup", setupRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/public", publicAPIRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/dashboard", studentDash);
app.use("/api", superAdminRoutes);

// 404 Middleware
app.use(notFound);

// Always at the end, after all routes
app.use(errorMiddleware);

// Function to start the server after DB connection
async function startServer() {
  try {
    console.log("Connecting to database...");
    await prisma.$connect();
    console.log("Database connected successfully!");

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
  } catch (error) {
    console.error("Failed to connect to database:", error);
    process.exit(1); // Stop the server if DB connection fails
  }
}

// Start the server
startServer();
