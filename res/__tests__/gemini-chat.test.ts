jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

import GeminiTextService from "../Services/GeminiTextService";
const gemini = GeminiTextService as any;

const reply = (obj: any, finishReason = "STOP") => ({
  ok: true,
  json: async () => ({
    candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(obj) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  }),
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test";
  (global as any).fetch = jest.fn();
});

describe("buildTeacherBrief", () => {
  it("is empty when the teacher said nothing", () => {
    expect(gemini.buildTeacherBrief([{ role: "user", kind: "start", content: "opening" }, { role: "model", content: "Q?" }])).toBe("");
  });

  it("keeps both sides, and drops the opening message and refinements", () => {
    const brief = gemini.buildTeacherBrief([
      { role: "user", kind: "start", content: "opening" },
      { role: "model", kind: "chat", content: "Which method?" },
      { role: "user", kind: "chat", content: "group work" },
      { role: "user", kind: "refine", content: "shorter" },
    ]);
    expect(brief).toBe("Assistant: Which method?\nTeacher: group work");
  });

  it("keeps the newest part when it is too long", () => {
    const brief = gemini.buildTeacherBrief([
      { role: "user", kind: "chat", content: "old ".repeat(3000) },
      { role: "user", kind: "chat", content: "NEWEST" },
    ]);
    expect(brief.length).toBeLessThanOrEqual(gemini.MAX_BRIEF_CHARS);
    expect(brief.endsWith("NEWEST")).toBe(true);
  });
});

describe("buildLessonNotePrompt", () => {
  const base = { className: "SS2", subjectName: "Biology" };

  it("lets the scheme decide what is covered, and the teacher decide how, only when there is a brief", () => {
    const withBrief = gemini.buildLessonNotePrompt({ ...base, teacherBrief: "Teacher: use market examples" });
    expect(withBrief).toContain("decides WHAT is covered");
    expect(withBrief).toContain("decide HOW the lesson is taught");

    const without = gemini.buildLessonNotePrompt(base);
    expect(without).toContain("decides WHAT is covered");
    expect(without).not.toContain("decide HOW");
  });
});

describe("chatTurn", () => {
  const input = {
    history: [{ role: "user", content: "start" }, { role: "model", content: "Q?" }, { role: "user", content: "group work" }],
    schemeText: "Week 1: Photosynthesis", className: "SS2", subjectName: "Biology", topic: "Photosynthesis",
  };

  it("sends the scheme in the system instruction and the conversation as alternating roles", async () => {
    (global as any).fetch.mockResolvedValue(reply({ reply: "Great.", readyToGenerate: true }));

    const out = await gemini.chatTurn(input);

    const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
    expect(body.systemInstruction.parts[0].text).toContain("Week 1: Photosynthesis");
    expect(body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.generationConfig.maxOutputTokens).toBe(gemini.CHAT_MAX_OUTPUT_TOKENS);
    expect(out).toEqual({ reply: "Great.", readyToGenerate: true, usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it("reports a reply cut off at the ceiling for what it is", async () => {
    (global as any).fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"reply":"cut' }] } }] }) });
    await expect(gemini.chatTurn(input)).rejects.toThrow("cut off");
  });

  it("rejects an empty reply", async () => {
    (global as any).fetch.mockResolvedValue(reply({ reply: "  ", readyToGenerate: false }));
    await expect(gemini.chatTurn(input)).rejects.toThrow("empty reply");
  });
});

describe("generateLessonNote with a brief", () => {
  it("puts the conversation in the request", async () => {
    (global as any).fetch.mockResolvedValue(reply({ title: "T", objectives: ["a"], content: "body" }));

    await gemini.generateLessonNote({
      schemeText: "Week 1", className: "SS2", subjectName: "Biology", topic: "Photo", teacherBrief: "Teacher: market examples",
    });

    const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
    expect(JSON.stringify(body.contents)).toContain("market examples");
  });
});

describe("refineNote", () => {
  it("sends the note and the request, and returns the whole revised note", async () => {
    (global as any).fetch.mockResolvedValue(reply({ title: "T2", objectives: ["b"], content: "revised" }));

    const out = await gemini.refineNote({
      schemeText: "Week 1", className: "SS2", subjectName: "Biology", topic: "Photo",
      note: { title: "T", objectives: ["a"], content: "original body" }, instruction: "make it shorter",
    });

    const sent = JSON.stringify(JSON.parse((global as any).fetch.mock.calls[0][1].body).contents);
    expect(sent).toContain("original body");
    expect(sent).toContain("make it shorter");
    expect(out.parsed.content).toBe("revised");
  });
});
