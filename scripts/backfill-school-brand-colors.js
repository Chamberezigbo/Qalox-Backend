require('dotenv').config();

const prisma = require("../res/util/prisma");
const r2Service = require("../res/Services/R2Service");
const { extractDominantColor } = require("../res/config/compress");

/**
 * One-off: every school already has a required, already-stored logo, but
 * `brandColor` didn't exist as a column until now. Run once after the
 * migration deploys so existing schools get themed immediately instead of
 * only future signups. Not a recurring job — schools onboarded after this
 * already get their brandColor set at signup time (schoolController.js).
 */
async function backfillSchoolBrandColors() {
  try {
    console.log("🎨 Backfilling brand colors for existing schools...");

    const schools = await prisma.school.findMany({
      where: { brandColor: null, logoUrl: { not: null } },
      select: { id: true, name: true, logoUrl: true },
    });

    console.log(`Found ${schools.length} school(s) needing a brand color.`);

    let updated = 0;
    let skipped = 0;

    for (const school of schools) {
      try {
        if (!school.logoUrl.startsWith("r2:")) {
          console.log(`  - Skipping "${school.name}" (logoUrl isn't an r2: key)`);
          skipped++;
          continue;
        }

        const key = school.logoUrl.slice(3);
        const buffer = await r2Service.getObjectBuffer(key);
        const brandColor = await extractDominantColor(buffer);

        if (!brandColor) {
          console.log(`  - Skipping "${school.name}" (no usable color found in logo)`);
          skipped++;
          continue;
        }

        await prisma.school.update({ where: { id: school.id }, data: { brandColor } });
        console.log(`  ✓ "${school.name}" → ${brandColor}`);
        updated++;
      } catch (err) {
        console.error(`  ✗ Failed for "${school.name}":`, err.message);
        skipped++;
      }
    }

    console.log(`\n✅ Done. Updated ${updated}, skipped ${skipped}.`);
  } catch (err) {
    console.error("❌ Backfill failed:", err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

backfillSchoolBrandColors();
