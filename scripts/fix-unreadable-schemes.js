require("dotenv").config();

const prisma = require("../res/util/prisma");

/**
 * One-off: mark schemes of work "failed" when they were saved as "ready" but
 * hold almost no text.
 *
 * A scanned PDF has no text layer. pdf-parse returned only its page markers
 * ("-- 1 of 1 --"), which was saved as a ready scheme, so the school saw a
 * working scheme that lesson-note generation then could not use. The upload
 * path now refuses empty extractions; this repairs the rows that were saved
 * before that.
 *
 * Only touches schemes that are "ready" AND have under MIN_CHARS of text after
 * page markers are removed. Never touches a scheme that has produced a lesson
 * note or generation job, and never changes the text itself.
 *
 * Reports by default. Pass --apply to write.
 *
 *   node scripts/fix-unreadable-schemes.js            # report, change nothing
 *   node scripts/fix-unreadable-schemes.js --apply    # write
 */

const APPLY = process.argv.includes("--apply");
const MIN_CHARS = 100;
const MESSAGE =
  "No readable text could be extracted from this file. It looks like a scanned document. Upload a text PDF or clear photos of each page.";

/** pdf-parse's own page separators carry no content. */
const withoutPageMarkers = (text) => (text || "").replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "").trim();

async function main() {
  console.log(APPLY ? "⚠️  APPLYING changes\n" : "🔍 Report only — nothing will be written\n");

  const ready = await prisma.schemeOfWork.findMany({
    where: { extractedTextStatus: "ready" },
    select: {
      id: true,
      schoolId: true,
      title: true,
      status: true,
      extractedText: true,
      class: { select: { name: true } },
      subject: { select: { name: true } },
    },
  });

  const unreadable = ready.filter((s) => withoutPageMarkers(s.extractedText).length < MIN_CHARS);

  if (unreadable.length === 0) {
    console.log("No ready scheme of work is missing its text.");
    return;
  }

  let updated = 0;
  for (const scheme of unreadable) {
    const used =
      (await prisma.lessonNote.count({ where: { schemeOfWorkId: scheme.id } })) +
      (await prisma.aiGenerationJob.count({ where: { schemeOfWorkId: scheme.id } }));

    const label = `scheme ${scheme.id} · school ${scheme.schoolId} · ${scheme.class?.name} ${scheme.subject?.name} · "${scheme.title}" · ${withoutPageMarkers(scheme.extractedText).length} chars`;

    if (used > 0) {
      console.log(`  skip  ${label} — already used by ${used} lesson note(s) or job(s)`);
      continue;
    }

    console.log(`  ${APPLY ? "fix " : "would fix"}  ${label}`);

    if (APPLY) {
      // The status filter keeps a scheme that was re-extracted in the meantime untouched.
      const { count } = await prisma.schemeOfWork.updateMany({
        where: { id: scheme.id, extractedTextStatus: "ready" },
        data: { extractedTextStatus: "failed", extractionError: MESSAGE },
      });
      updated += count;
    }
  }

  console.log(APPLY ? `\n✅ Marked ${updated} scheme(s) as failed.` : "\nRe-run with --apply to write these changes.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("❌ Failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
