/**
 * Fills the past-question practice bank with AI-written, exam-style questions.
 *
 *   node scripts/generate-practice-bank.js --exam wassce --subject Biology --topics 10 --per-topic 10
 *   node scripts/generate-practice-bank.js --exam bece                      (every BECE subject)
 *   node scripts/generate-practice-bank.js --exam waec --subject Physics --dry-run
 *
 * Options
 *   --exam       bece | wassce | waec | neco | waec_gce | tvet   (required)
 *   --subject    one subject name; omit for every subject of the exam
 *   --topics     how many syllabus topics to cover per subject (default 10, max 20)
 *   --per-topic  questions to write per topic (default 10, max 20)
 *   --difficulty easy | medium | hard (default medium)
 *   --dry-run    only show what would be done and roughly what it would cost
 *
 * Needs DATABASE_URL and GEMINI_API_KEY in the environment (the same .env the server uses).
 * Every question is double-checked by an independent second AI pass: only questions where both
 * agree are shown to students; the rest wait in `needs_review`.
 * This is a platform cost. It is not charged to any school's AI credits.
 */
require("dotenv").config();
const { EXAMS, examByKey, canonicalSubject } = require("../res/util/practiceCatalog");
const gemini = require("../res/Services/GeminiPracticeService");
const bank = require("../res/Services/PracticeBankService");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi, fallback) => Math.min(Math.max(Number(v) || fallback, lo), hi);

async function withRetry(label, fn) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const busy = error.code === "AI_RATE_LIMITED" || error.code === "AI_BUSY";
      if (!busy || attempt === 4) throw error;
      const wait = attempt * 20000;
      console.log(`  ${label}: the AI service is busy, waiting ${wait / 1000}s (try ${attempt} of 3)...`);
      await sleep(wait);
    }
  }
}

(async () => {
  const exam = examByKey(args.exam);
  if (!exam) {
    console.error(`Choose --exam from: ${EXAMS.map((e) => e.key).join(", ")}`);
    process.exit(1);
  }
  const subjects = args.subject ? [canonicalSubject(exam.key, String(args.subject))] : exam.subjects;
  if (subjects.some((s) => !s)) {
    console.error(`"${args.subject}" is not a ${exam.name} subject. Choose from: ${exam.subjects.join(", ")}`);
    process.exit(1);
  }
  const topicsWanted = clamp(args.topics, 1, 20, 10);
  const perTopic = clamp(args["per-topic"], 1, gemini.MAX_PER_CALL, 10);
  const difficulty = ["easy", "medium", "hard"].includes(args.difficulty) ? args.difficulty : "medium";

  const calls = subjects.length * (1 + topicsWanted * 2); // topic list + (generate + check) per topic
  console.log(`${exam.name}: ${subjects.length} subject(s), up to ${topicsWanted} topics x ${perTopic} questions = about ${subjects.length * topicsWanted * perTopic} questions, ~${calls} AI calls.`);
  if (args["dry-run"]) {
    console.log("Dry run: nothing was written.");
    return;
  }

  const totals = { written: 0, approved: 0, needsReview: 0, duplicates: 0 };
  for (const subject of subjects) {
    console.log(`\n${subject}`);
    let topics;
    try {
      topics = await withRetry("topics", () => gemini.suggestTopics({ exam: exam.key, subject, max: topicsWanted }));
    } catch (error) {
      console.log(`  could not list topics (${error.message}); skipping`);
      continue;
    }
    for (const topic of topics) {
      try {
        const r = await withRetry(topic, () => bank.generate({ exam: exam.key, subject, topic, count: perTopic, difficulty }));
        for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0;
        console.log(`  ${topic}: ${r.approved} approved, ${r.needsReview} to review${r.duplicates ? `, ${r.duplicates} duplicates` : ""}`);
      } catch (error) {
        console.log(`  ${topic}: failed (${error.message})`);
      }
      await sleep(1500);
    }
  }
  console.log(`\nDone. ${totals.written} questions written: ${totals.approved} approved, ${totals.needsReview} waiting for review, ${totals.duplicates} duplicates skipped.`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
