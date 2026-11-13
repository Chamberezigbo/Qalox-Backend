export {};
const { normalizeQuestion, csvToItems, parseCsv, pickQuestionIds, gradeAnswers, examMinutes, contentHash } = require("../util/practiceQuestions");
const { canonicalSubject, questionLabel } = require("../util/practiceCatalog");

const good = (over: any = {}) => ({
  exam: "WAEC", subject: "biology", year: 2019, text: "Which organelle is the site of photosynthesis?",
  options: ["A. Mitochondrion", "B. Chloroplast", "C. Nucleus", "D. Ribosome"], correct: "B", explanation: "Chloroplasts contain chlorophyll.", ...over,
});

describe("normalizeQuestion", () => {
  it("accepts a real past question, cleaning option labels and the exam/subject names", () => {
    const { question } = normalizeQuestion(good());
    expect(question).toMatchObject({ exam: "waec", subject: "Biology", source: "past_question", year: 2019 });
    expect(question.options.map((o: any) => o.text)).toEqual(["Mitochondrion", "Chloroplast", "Nucleus", "Ribosome"]);
    expect(question.options.filter((o: any) => o.isCorrect).map((o: any) => o.text)).toEqual(["Chloroplast"]);
  });
  it("finds the correct option by letter, number, index or its own text", () => {
    const answer = (correct: any) => normalizeQuestion(good({ correct })).question.options.findIndex((o: any) => o.isCorrect);
    expect([answer("c"), answer("2"), answer(0), answer("nucleus")]).toEqual([2, 1, 0, 2]);
  });
  it.each([
    [{ exam: "jamb" }, "Unknown exam"],
    [{ subject: "Astrology" }, "not a WAEC subject"],
    [{ year: undefined }, "needs the year"],
    [{ year: 1901 }, "valid exam year"],
    [{ text: "Hi" }, "too short"],
    [{ options: ["only one"] }, "needs 2 to 6"],
    [{ options: ["a", "A", "b", "c"] }, "same"],
    [{ correct: "Z" }, "Say which option"],
    [{ source: "scraped" }, "source must be"],
  ])("rejects a bad question: %j", (over, text) => {
    expect(normalizeQuestion(good(over)).problem).toContain(text);
  });
  it("lets an AI-practice question have no year", () => {
    expect(normalizeQuestion(good({ source: "ai_practice", year: undefined })).question.year).toBeNull();
  });
  it("gives the same hash for the same question however it is spaced or capitalised", () => {
    const a = contentHash({ text: "What  is DNA?", options: [{ text: "X" }, { text: "Y" }] });
    expect(a).toBe(contentHash({ text: "what is dna?", options: [{ text: "x" }, { text: "y" }] }));
    expect(a).not.toBe(contentHash({ text: "What is RNA?", options: [{ text: "X" }, { text: "Y" }] }));
  });
});

describe("CSV", () => {
  it("reads quoted fields with commas, quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
  it("turns rows into questions using loose column names", () => {
    const items = csvToItems('Exam,Subject,Year,Question,Option A,Option B,Option C,Option D,Correct,Explanation\nneco,Biology,2018,"What, exactly, is DNA?",x,y,z,w,C,because\n');
    expect(items[0]).toMatchObject({ exam: "neco", subject: "Biology", year: "2018", text: "What, exactly, is DNA?", options: ["x", "y", "z", "w"], correct: "C", explanation: "because" });
    expect(normalizeQuestion(items[0]).question.options[2].isCorrect).toBe(true);
  });
});

describe("choosing and grading", () => {
  it("picks unseen questions first, then seen ones, and never more than exist", () => {
    const seen = new Set([1, 2, 3]);
    const picked = pickQuestionIds([1, 2, 3, 4, 5, 6], seen, 4);
    expect(picked).toHaveLength(4);
    expect(picked.every((id: number) => [4, 5, 6].includes(id) || seen.has(id))).toBe(true);
    expect(new Set(picked.slice(0, 3))).toEqual(new Set([4, 5, 6]));
    expect(pickQuestionIds([1, 2], new Set(), 10)).toHaveLength(2);
    expect(new Set(pickQuestionIds([1, 2, 3, 4], new Set(), 4)).size).toBe(4);
  });
  it("counts a skipped question as wrong", () => {
    const options = new Map([[1, [{ id: 10, isCorrect: true }, { id: 11, isCorrect: false }]], [2, [{ id: 20, isCorrect: false }, { id: 21, isCorrect: true }]], [3, [{ id: 30, isCorrect: true }]]]);
    const out = gradeAnswers([1, 2, 3], options, new Map([[1, 10], [2, 20]]));
    expect(out).toMatchObject({ score: 1, total: 3 });
    expect(out.marked.map((m: any) => m.isCorrect)).toEqual([true, false, false]);
  });
  it("gives exam mode just under a minute a question, never under ten minutes", () => {
    expect([examMinutes(10), examMinutes(20), examMinutes(40)]).toEqual([10, 18, 36]);
  });
});

describe("catalog", () => {
  it("knows the six exams and their subjects", () => {
    expect(canonicalSubject("tvet", "auto mechanics")).toBe("Auto Mechanics");
    expect(canonicalSubject("bece", "Biology")).toBeNull();
    expect(canonicalSubject("jamb", "Biology")).toBeNull();
  });
  it("labels a real paper with its year and an AI question honestly", () => {
    expect(questionLabel({ exam: "waec", source: "past_question", year: 2019 })).toBe("Past question · WAEC 2019");
    expect(questionLabel({ exam: "neco", source: "ai_practice", year: null })).toBe("Practice question · NECO style");
  });
});
