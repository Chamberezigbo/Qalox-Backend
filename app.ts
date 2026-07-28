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
const setupRoutes = require("./res/routes/setup");
const superAdminRoutes = require("./res/routes/superadmin/superadmin");
const { errorMiddleware } = require("./res/middleware/error");
const publicRoutes = require("./res/routes/public");
const publicAPIRoutes = require("./res/routes/publicAPI");
const { notFound } = require("./res/middleware/404");
const studentDash = require("./res/routes/studentDashboard");
const requestLogger = require("./res/middleware/requestLogger");
const logger = require("./res/config/logger");
const documentationMiddleware = require("./res/middleware/documentation");

const app = express();

// Enable CORS with configurable origins from .env
const corsCredentials = process.env.CORS_CREDENTIALS === "true";

// In development, allow all localhost variants for easier testing
const corsOrigin = (origin, callback) => {
  if (process.env.NODE_ENV === "development") {
    // Allow all localhost variants in development
    if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  } else {
    // In production, use specific origins from .env
    const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map(o => o.trim()) || [];
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  }
};

app.use(cors({
  origin: corsOrigin,
  credentials: corsCredentials,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-service-key"],
}));

// Parse JSON bodies
app.use(express.json());

// Request logging middleware - logs all incoming requests and responses
app.use(requestLogger);

// Documentation middleware - Swagger UI at /docs (enable with ENABLE_DOCS=true)
documentationMiddleware(app);

// Log server startup
logger.info("✅ Qalox Backend Server Starting", {
  environment: process.env.NODE_ENV || "development",
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
app.use("/api/setup", setupRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/public", publicAPIRoutes);
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
