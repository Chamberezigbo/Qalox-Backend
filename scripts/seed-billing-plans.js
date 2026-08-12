require('dotenv').config();

const prisma = require("../res/util/prisma");

// These strings must match the checkbox labels in
// QALOX-SUPER-ADMIN/frontend/.../billing/components/PlanFormModal.vue's
// FEATURE_GROUPS exactly, so a seeded plan opens in the edit modal with the
// right boxes already checked.
const commonFeatures = [
  "Teacher Portal",
  "Student Portal",
  "Parent Portal",
  "Class & Campus Setup",
  "Multi-Campus Support",
  "Sub-Admin Roles",
  "Basic Attendance",
  "Attendance Analytics",
  "Results Entry",
  "Exam Scheduling",
  "Notices & Announcements",
  "Broadcast / Communications",
  "Fee Management",
  "Online Fee Payments",
  "Analytics Dashboard",
  "Advanced Reporting",
];

const AI_FEATURE = "AI Lesson Note and Exam Question Generator";

const PLANS = [
  {
    name: "Basic",
    description: "For schools with up to 300 students",
    monthlyPrice: 40000,
    annualPrice: 110000,
    minStudents: 0,
    maxStudents: 300,
    maxSubAdmins: 1,
    isActive: true,
    highlighted: false,
    features: ["Admin Portal (Admin & 1 Sub-Admin only)", ...commonFeatures],
  },
  {
    name: "Standard",
    description: "For schools with 301-700 students",
    monthlyPrice: 70000,
    annualPrice: 200000,
    minStudents: 301,
    maxStudents: 700,
    maxSubAdmins: 5,
    isActive: true,
    highlighted: true,
    features: ["Admin Portal (Admin & 5 Sub-Admins)", AI_FEATURE, ...commonFeatures],
  },
  {
    name: "Premium",
    description: "For schools with unlimited students",
    monthlyPrice: 300000,
    annualPrice: 800000,
    minStudents: 701,
    maxStudents: null,
    maxSubAdmins: null,
    isActive: true,
    highlighted: false,
    features: ["Admin Portal (Admin & Unlimited Sub-Admins)", AI_FEATURE, ...commonFeatures],
  },
];

async function seedBillingPlans() {
  try {
    console.log("🌱 Seeding real billing plans (Basic / Standard / Premium)...");

    for (const plan of PLANS) {
      const { features, ...rest } = plan;
      const data = { ...rest, features: JSON.stringify(features) };

      const existing = await prisma.billingPlan.findUnique({ where: { name: plan.name } });
      if (existing) {
        await prisma.billingPlan.update({ where: { id: existing.id }, data });
        console.log(`✅ Updated existing plan: ${plan.name}`);
      } else {
        await prisma.billingPlan.create({ data });
        console.log(`✅ Created plan: ${plan.name}`);
      }
    }

    console.log("🌱 Done.");
    await prisma.$disconnect();
  } catch (error) {
    console.error("❌ Failed to seed billing plans:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

seedBillingPlans();
