require('dotenv').config();

const prisma = require("../res/util/prisma");
const bcrypt = require("bcryptjs");

async function seedSuperAdmin() {
  try {
    console.log("🌱 Seeding super admin user...");

    // Check if super admin already exists
    const existingSuperAdmin = await prisma.admin.findFirst({
      where: { role: "super_admin" },
    });

    if (existingSuperAdmin) {
      console.log("✅ Super admin already exists:", existingSuperAdmin.email);
      await prisma.$disconnect();
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash("SuperAdmin123!", 10);

    // Create super admin
    const superAdmin = await prisma.admin.create({
      data: {
        email: "super-admin@qalox.com",
        name: "Super Administrator",
        password: hashedPassword,
        role: "super_admin",
        hasLoggedIn: false,
      },
    });

    console.log("✅ Super admin created successfully!");
    console.log("   Email:", superAdmin.email);
    console.log("   Password: SuperAdmin123!");
    console.log("   ID:", superAdmin.id);
    console.log("\n⚠️  IMPORTANT: Change this password after first login!");

  } catch (err) {
    console.error("❌ Error seeding super admin:", err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seedSuperAdmin();
