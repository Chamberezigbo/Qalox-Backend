/**
 * The public exams students can practise for, and the subjects each one offers.
 * A code constant on purpose: these are the labels students see and the values imports are
 * checked against, so they change by a deliberate edit, not by whatever a spreadsheet contains.
 */

const SENIOR_CORE = [
  "English Language", "General Mathematics", "Biology", "Chemistry", "Physics", "Economics", "Government",
  "Literature in English", "Geography", "Christian Religious Studies", "Islamic Studies", "Commerce",
  "Financial Accounting", "Civic Education", "Agricultural Science", "Further Mathematics", "Computer Studies",
  "Technical Drawing", "Food and Nutrition", "History", "Marketing",
];

const EXAMS = [
  {
    key: "bece",
    name: "BECE",
    fullName: "Basic Education Certificate Examination",
    level: "Junior secondary (JSS 3)",
    subjects: [
      "English Studies", "Mathematics", "Basic Science", "Basic Technology", "Social Studies", "Civic Education",
      "Christian Religious Studies", "Islamic Studies", "Business Studies", "Agricultural Science", "Home Economics",
      "Physical and Health Education", "Computer Studies", "French", "Cultural and Creative Arts",
    ],
  },
  { key: "wassce", name: "WASSCE", fullName: "West African Senior School Certificate Examination", level: "Senior secondary (SS 3)", subjects: SENIOR_CORE },
  { key: "waec", name: "WAEC", fullName: "WAEC Senior School Certificate Examination (SSCE)", level: "Senior secondary (SS 3)", subjects: SENIOR_CORE },
  { key: "neco", name: "NECO", fullName: "National Examinations Council (SSCE)", level: "Senior secondary (SS 3)", subjects: SENIOR_CORE },
  { key: "waec_gce", name: "WAEC GCE", fullName: "WAEC General Certificate of Education (private candidates)", level: "Senior secondary (private)", subjects: SENIOR_CORE },
  {
    key: "tvet",
    name: "TVET",
    fullName: "Technical and Vocational Education and Training",
    level: "Technical and vocational",
    subjects: [
      "Auto Mechanics", "Electrical Installation", "Electronics", "Welding and Fabrication", "Block Laying and Concrete Work",
      "Carpentry and Joinery", "Plumbing and Pipe Fitting", "Catering Craft Practice", "Garment Making", "Cosmetology",
      "Refrigeration and Air Conditioning", "Data Processing", "Tourism and Hospitality", "Photography", "Printing Craft Practice",
    ],
  },
];

const EXAM_KEYS = EXAMS.map((e) => e.key);

const examByKey = (key) => EXAMS.find((e) => e.key === key) ?? null;

/** True when `subject` is one the exam offers (exact, case-insensitive). Returns the canonical name or null. */
function canonicalSubject(examKey, subject) {
  const exam = examByKey(examKey);
  if (!exam || typeof subject !== "string") return null;
  const wanted = subject.trim().toLowerCase();
  return exam.subjects.find((s) => s.toLowerCase() === wanted) ?? null;
}

/** "WAEC style" / "WAEC 2019": how a question is labelled for the student. */
function questionLabel({ exam, source, year }) {
  const name = examByKey(exam)?.name ?? exam;
  return source === "past_question" && year ? `Past question · ${name} ${year}` : `Practice question · ${name} style`;
}

module.exports = { EXAMS, EXAM_KEYS, examByKey, canonicalSubject, questionLabel };
