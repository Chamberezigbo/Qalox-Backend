/**
 * Clears a school's coupon redemption record so they can redeem another
 * coupon during testing.
 *
 * CouponRedemption has @@unique([schoolId]) by design — "one coupon
 * redemption per school, ever" (see prisma/schema.prisma) — which is the
 * correct anti-abuse rule for real schools and is NOT changed by this
 * script. This only deletes the redemption row for one named (test) school
 * so the same account can go through the redeem flow again.
 *
 * Note: this clears the redemption record only. It does not revert the free
 * days or plan the earlier redemption already granted — check Current Plan
 * / Billing after running this if that matters for your test.
 *
 * Usage:
 *   node scripts/reset-coupon-redemption.js "Daniel's College" --dry-run
 *   node scripts/reset-coupon-redemption.js "Daniel's College"
 */

require("dotenv").config();

const prisma = require("../res/util/prisma");

const schoolName = process.argv[2];
const DRY_RUN = process.argv.includes("--dry-run");

if (!schoolName) {
  console.error('Usage: node scripts/reset-coupon-redemption.js "School Name" [--dry-run]');
  process.exit(1);
}

(async () => {
  const school = await prisma.school.findFirst({ where: { name: schoolName } });
  if (!school) {
    console.error(`No school found named "${schoolName}"`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const redemptions = await prisma.couponRedemption.findMany({
    where: { schoolId: school.id },
    include: { coupon: { select: { code: true } } },
  });

  if (redemptions.length === 0) {
    console.log(`"${school.name}" has no coupon redemption on record — nothing to reset.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`"${school.name}" (id ${school.id}) has redeemed:`);
  for (const r of redemptions) console.log(`  ${r.coupon.code} on ${r.redeemedAt.toISOString()}`);

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing deleted.");
    await prisma.$disconnect();
    return;
  }

  await prisma.couponRedemption.deleteMany({ where: { schoolId: school.id } });
  console.log(`\nCleared. "${school.name}" can redeem a coupon again.`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
