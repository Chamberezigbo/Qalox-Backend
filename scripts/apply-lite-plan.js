require("dotenv").config();

const prisma = require("../res/util/prisma");

/**
 * One-off: introduce the Lite tier and give Basic a real AI allowance.
 *
 * Deliberately NOT done by re-running seed-billing-plans.js. That script
 * rewrites every field on every plan it matches, and production has drifted
 * from it (a past save through the Super Admin plan form reordered Basic's
 * features and blanked its sub-admin cap). A targeted write changes only the
 * fields this change is about and leaves Standard and Premium untouched.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node scripts/apply-lite-plan.js           # show the diff, change nothing
 *   node scripts/apply-lite-plan.js --apply   # write it
 */

const APPLY = process.argv.includes("--apply");

const AI_FEATURE = "AI Lesson Note and Exam Question Generator";

// Mirrors seed-billing-plans.js. Lite drops Multi-Campus Support and Advanced
// Reporting so it doesn't render as an identical card to Basic at a lower price.
const LITE_FEATURES = [
  "Admin Portal (Admin & 1 Sub-Admin only)",
  AI_FEATURE,
  "Teacher Portal",
  "Student Portal",
  "Parent Portal",
  "Class & Campus Setup",
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
];

const LITE = {
  name: "Lite",
  description: "For schools with up to 50 students",
  monthlyPrice: 20000,
  annualPrice: 54000, // 3 terms less 10%
  minStudents: 0,
  maxStudents: 50,
  smsQuotaPerTerm: null, // mirrors maxStudents (50)
  aiCreditsPerTerm: 150, // ~75 lesson notes per term
  maxSubAdmins: 1,
  isActive: true,
  highlighted: false,
  features: JSON.stringify(LITE_FEATURES),
};

/** Only the fields this change is about — everything else on Basic is left alone. */
const BASIC_CHANGES = {
  description: "For schools with 51-300 students",
  minStudents: 51,
  aiCreditsPerTerm: 400, // ~200 lesson notes per term
  maxSubAdmins: 1, // live value was null; Basic advertises "Admin & 1 Sub-Admin only"
};

const SELECT = {
  id: true, name: true, description: true, monthlyPrice: true, annualPrice: true,
  minStudents: true, maxStudents: true, maxSubAdmins: true,
  smsQuotaPerTerm: true, aiCreditsPerTerm: true, isActive: true, features: true,
};

async function main() {
  console.log(APPLY ? "⚠️  APPLYING changes\n" : "🔍 Dry run — nothing will be written\n");

  // ── Lite ──────────────────────────────────────────────────────────────────
  const existingLite = await prisma.billingPlan.findUnique({
    where: { name: "Lite" },
    select: SELECT,
  });

  if (existingLite) {
    console.log("Lite already exists (id %s) — leaving it alone.", existingLite.id);
  } else {
    console.log("Lite: CREATE");
    console.log("  %o", { ...LITE, features: `${LITE_FEATURES.length} features` });
    if (APPLY) {
      const created = await prisma.billingPlan.create({ data: LITE });
      console.log("  ✅ created id %s", created.id);
    }
  }

  // ── Basic ─────────────────────────────────────────────────────────────────
  const basic = await prisma.billingPlan.findUnique({
    where: { name: "Basic" },
    select: SELECT,
  });

  if (!basic) {
    throw new Error("No plan named 'Basic' — refusing to guess which plan was meant.");
  }

  // Add the AI feature string to whatever Basic currently advertises rather
  // than replacing the list, so the ordering already in production survives.
  const currentFeatures = JSON.parse(basic.features);
  const needsAiFeature = !currentFeatures.includes(AI_FEATURE);
  const nextFeatures = needsAiFeature
    ? [currentFeatures[0], AI_FEATURE, ...currentFeatures.slice(1)]
    : currentFeatures;

  console.log("\nBasic (id %s): UPDATE", basic.id);
  for (const [field, next] of Object.entries(BASIC_CHANGES)) {
    const marker = basic[field] === next ? "   (unchanged)" : "";
    console.log("  %s: %o → %o%s", field, basic[field], next, marker);
  }
  console.log("  features: %s", needsAiFeature ? `+ "${AI_FEATURE}"` : "already present (unchanged)");

  if (APPLY) {
    await prisma.billingPlan.update({
      where: { id: basic.id },
      data: { ...BASIC_CHANGES, features: JSON.stringify(nextFeatures) },
    });
    console.log("  ✅ updated");
  }

  // ── Read back ─────────────────────────────────────────────────────────────
  if (APPLY) {
    const after = await prisma.billingPlan.findMany({
      orderBy: { monthlyPrice: "asc" },
      select: {
        name: true, monthlyPrice: true, minStudents: true, maxStudents: true,
        maxSubAdmins: true, aiCreditsPerTerm: true, isActive: true,
      },
    });
    console.log("\n📋 Plans now:");
    console.table(after);
  } else {
    console.log("\nRe-run with --apply to write these changes.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("❌ Failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
