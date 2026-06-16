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
const { errorMiddleware } = require("./res/middleware/error");
const publicRoutes = require("./res/routes/public");
const { notFound } = require("./res/middleware/404");
const studentDash = require("./res/routes/studentDashboard");

const app = express();

// Enable CORS for all origins during development/demo
// For production, configure specific origins
app.use(cors({
  origin: "*",
  credentials: false
}));

// Parse JSON bodies//
app.use(express.json());

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
app.use("/api/dashboard", studentDash);

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
