const crypto = require("crypto");
const sharp = require("sharp");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const AiCreditService = require("../../Services/AiCreditService");
const GeminiTextService = require("../../Services/GeminiTextService");
const ExamPaperAi = require("../../Services/ExamPaperAiService");
const r2 = require("../../Services/R2Service");
const { classDisplayName } = require("../../util/classLabel");
const { normalizePaper, parsePaper, questionCount, imagePrefix, newId, LIMITS } = require("../../util/examPaper");
const { buildExamPaperPdf } = require("../../util/examPaperPdf");
const { loadImage } = require("../../util/reportCardPdf");
const { resolveBranding } = require("../../util/campusBranding");
const { schoolMediaUrl } = require("../public/publicController");
const { sendPdf } = require("../../util/sendPdf");

/**
 * Chat with the AI to build ONE printable exam paper.
 *
 * Each teacher turn reserves credits against its worst case, calls Gemini, and trues up to
 * the real usage (refunded in full when the call fails). A diagram the AI draws is billed
 * per image and refunded if it cannot be drawn. Whatever the AI returns is rebuilt through
 * normalizePaper before it is stored: nothing it sends is trusted as it arrives.
 */

const MAX_MESSAGE_CHARS = 2000;
const MAX_TURNS = 60;
const MAX_PAPERS_PER_DAY = 30;
const MAX_GENERATED_IMAGES_PER_TURN = 3;

class ChatError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function fail(error, res, next) {
  if (error instanceof ChatError) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code, data: error.data });
  }
  // AppError from the credit check (not enough credits, no plan).
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: "CREDITS" });
  }
  logger.error("[EXAM_PAPER] Request failed", { error: error.message });
  return next(error);
}

async function assertTeaches(staffId, classId, subjectId) {
  const taught = await prisma.teacherAssignment.findFirst({ where: { staffId, classId, subjectId } });
  if (!taught) throw new ChatError(403, "You do not teach this subject in this class", "NOT_YOUR_CLASS");
}

/** The teacher's own paper; 404 for anyone else's, whatever its id. */
async function loadChat(req) {
  const chat = await prisma.examPaperChat.findFirst({
    where: { id: Number(req.params.id), staffId: req.staffId, schoolId: req.schoolId },
  });
  if (!chat) throw new ChatError(404, "Exam paper not found", "NOT_FOUND");
  return chat;
}

async function loadContext(schoolId, chat) {
  const [cls, subject, term] = await Promise.all([
    prisma.class.findFirst({ where: { id: chat.classId, schoolId }, select: { name: true, customName: true, campusId: true } }),
    prisma.subject.findFirst({ where: { id: chat.subjectId, schoolId }, select: { name: true } }),
    prisma.academicTerm.findFirst({ where: { schoolId, isActive: true }, select: { id: true, name: true }, orderBy: { createdAt: "desc" } }),
  ]);
  // The scheme of work is optional: used when there is a readable one for this term.
  let schemeExcerpt = null;
  if (term) {
    const row = await prisma.schemeOfWork.findFirst({
      where: { schoolId, classId: chat.classId, subjectId: chat.subjectId, academicTermId: term.id, status: "active", extractedTextStatus: "ready" },
      select: { extractedText: true },
    });
    if (row?.extractedText) schemeExcerpt = GeminiTextService.buildContextExcerpt(row.extractedText, undefined) || null;
  }
  return {
    className: cls ? classDisplayName(cls.name, cls.customName) : "",
    campusId: cls?.campusId ?? null,
    subjectName: subject?.name ?? "",
    termName: term?.name ?? null,
    schemeExcerpt,
  };
}

/** A stored image: resized, converted and put under this paper's folder. Returns the key. */
async function storeImage(chat, buffer) {
  const png = await sharp(buffer).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const key = `${imagePrefix(chat.schoolId, chat.id)}${crypto.randomBytes(8).toString("hex")}.png`;
  await r2.uploadObject({ buffer: png, key, contentType: "image/png" });
  return key;
}

/** The paper with a fresh link for each question's image. The links are never stored. */
async function withUrls(paper) {
  if (!paper) return null;
  const sections = await Promise.all(
    paper.sections.map(async (s) => ({
      ...s,
      questions: await Promise.all(
        s.questions.map(async (q) => {
          if (!q.imageKey) return q;
          const imageUrl = await r2.getPresignedUrl(q.imageKey).catch(() => null);
          return { ...q, imageUrl };
        })
      ),
    }))
  );
  return { ...paper, sections };
}

async function billedTurn(schoolId, estimate, call) {
  const { reserved } = await AiCreditService.reserveCredits(schoolId, AiCreditService.creditsForTokens(estimate));
  let result;
  try {
    result = await call();
  } catch (error) {
    await AiCreditService.refundCredits(schoolId, reserved).catch((e) =>
      logger.error("[EXAM_PAPER] Refund failed — school may be over-charged", { schoolId, reserved, error: e.message })
    );
    throw new ChatError(502, error.message, "AI_FAILED");
  }
  const { charged } = await AiCreditService.trueUpCredits(schoolId, reserved, result.usage);
  return { result, charged };
}

const turnEstimate = ({ system, history, paper, imageCount }) => ({
  inputTokens:
    AiCreditService.estimateTokensFromText(system) +
    AiCreditService.estimateTokensFromText(history.map((m) => m.content).join(" ")) +
    AiCreditService.estimateTokensFromText(paper ? JSON.stringify(paper) : "") +
    imageCount * AiCreditService.TOKENS_PER_IMAGE,
  outputTokens: ExamPaperAi.PAPER_MAX_OUTPUT_TOKENS,
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** POST /api/teacher/exam-papers  Body: { classId, subjectId, title? } */
exports.start = async (req, res, next) => {
  try {
    const { staffId, schoolId } = req;
    const classId = Number(req.body.classId);
    const subjectId = Number(req.body.subjectId);
    if (!classId || !subjectId) throw new ChatError(400, "Choose a class and a subject", "INVALID_REQUEST");
    await assertTeaches(staffId, classId, subjectId);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if ((await prisma.examPaperChat.count({ where: { staffId, createdAt: { gte: since } } })) >= MAX_PAPERS_PER_DAY) {
      throw new ChatError(429, `You've started ${MAX_PAPERS_PER_DAY} papers today. Try again tomorrow.`, "DAILY_LIMIT_REACHED");
    }

    const [cls, subject] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId }, select: { name: true, customName: true } }),
      prisma.subject.findFirst({ where: { id: subjectId, schoolId }, select: { name: true } }),
    ]);
    if (!cls || !subject) throw new ChatError(404, "Class or subject not found", "NOT_FOUND");

    const title = typeof req.body.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 200)
      : `${subject.name} — ${classDisplayName(cls.name, cls.customName)}`;

    const chat = await prisma.examPaperChat.create({ data: { schoolId, staffId, classId, subjectId, title } });
    res.status(201).json({ success: true, data: { id: chat.id, title: chat.title } });
  } catch (error) {
    fail(error, res, next);
  }
};

/** GET /api/teacher/exam-papers — the teacher's papers, newest first. */
exports.list = async (req, res, next) => {
  try {
    const chats = await prisma.examPaperChat.findMany({
      where: { staffId: req.staffId, schoolId: req.schoolId },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    const classIds = [...new Set(chats.map((c) => c.classId))];
    const subjectIds = [...new Set(chats.map((c) => c.subjectId))];
    const [classes, subjects] = await Promise.all([
      prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true, customName: true } }),
      prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
    ]);
    res.json({
      success: true,
      data: chats.map((c) => {
        const cls = classes.find((x) => x.id === c.classId);
        return {
          id: c.id,
          title: c.title,
          classId: c.classId,
          subjectId: c.subjectId,
          className: cls ? classDisplayName(cls.name, cls.customName) : "",
          subjectName: subjects.find((x) => x.id === c.subjectId)?.name ?? "",
          questionCount: questionCount(parsePaper(c.paperJson)),
          updatedAt: c.updatedAt,
        };
      }),
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/** GET /api/teacher/exam-papers/:id */
exports.get = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    const [messages, ctx] = await Promise.all([
      prisma.examPaperChatMessage.findMany({ where: { chatId: chat.id }, orderBy: { id: "asc" } }),
      loadContext(req.schoolId, chat),
    ]);
    const shaped = await Promise.all(
      messages.map(async (m) => {
        const keys = m.attachmentsJson ? JSON.parse(m.attachmentsJson) : [];
        const attachments = await Promise.all(keys.map((k) => r2.getPresignedUrl(k).catch(() => null)));
        return { id: m.id, role: m.role, content: m.content, attachments: attachments.filter(Boolean), createdAt: m.createdAt };
      })
    );
    res.json({
      success: true,
      data: {
        id: chat.id,
        title: chat.title,
        classId: chat.classId,
        subjectId: chat.subjectId,
        className: ctx.className,
        subjectName: ctx.subjectName,
        termName: ctx.termName,
        usesSchemeOfWork: !!ctx.schemeExcerpt,
        messages: shaped,
        paper: await withUrls(parsePaper(chat.paperJson)),
      },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/** DELETE /api/teacher/exam-papers/:id */
exports.remove = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    const paper = parsePaper(chat.paperJson);
    const keys = (paper?.sections ?? []).flatMap((s) => s.questions.map((q) => q.imageKey).filter(Boolean));
    await prisma.examPaperChatMessage.deleteMany({ where: { chatId: chat.id } });
    await prisma.examPaperChat.delete({ where: { id: chat.id } });
    // Best effort: a stray image in storage is harmless.
    await Promise.all(keys.map((k) => r2.deleteObject(k).catch(() => null)));
    res.json({ success: true, message: "Exam paper deleted" });
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * POST /api/teacher/exam-papers/:id/messages   (multipart: message, images[])
 * One turn of the conversation. Returns the AI's reply and, when it wrote or changed the
 * paper, the whole updated paper.
 */
exports.sendMessage = async (req, res, next) => {
  try {
    const text = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!text) throw new ChatError(400, "Write a message first.", "INVALID_REQUEST");
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new ChatError(400, `Keep each message under ${MAX_MESSAGE_CHARS} characters.`, "MESSAGE_TOO_LONG");
    }

    const chat = await loadChat(req);
    const [past, ctx] = await Promise.all([
      prisma.examPaperChatMessage.findMany({ where: { chatId: chat.id }, orderBy: { id: "asc" } }),
      loadContext(req.schoolId, chat),
    ]);
    if (past.filter((m) => m.role === "user").length >= MAX_TURNS) {
      throw new ChatError(429, "This chat is long enough. Start a new paper to keep going.", "CHAT_LIMIT_REACHED");
    }

    const previous = parsePaper(chat.paperJson);
    const files = req.files || [];
    const history = [
      ...past.map(({ role, content, attachmentsJson }) => ({
        role,
        content: attachmentsJson ? `${content}\n[The teacher attached ${JSON.parse(attachmentsJson).length} image(s)]` : content,
      })),
      { role: "user", content: text },
    ];

    // Images, stored once and looked at once: the AI sees them this turn, and can place one on a question.
    const attachmentKeys = [];
    const aiImages = [];
    for (const f of files) {
      attachmentKeys.push(await storeImage(chat, f.buffer));
      const small = await sharp(f.buffer).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      aiImages.push({ mimeType: "image/jpeg", data: small.toString("base64") });
    }

    const system = ExamPaperAi.buildSystemPrompt({ className: ctx.className, subjectName: ctx.subjectName, termName: ctx.termName, schemeExcerpt: ctx.schemeExcerpt });
    const { result, charged } = await billedTurn(
      req.schoolId,
      turnEstimate({ system, history, paper: previous, imageCount: aiImages.length }),
      () =>
        ExamPaperAi.chatTurn({
          history, paper: previous, images: aiImages,
          className: ctx.className, subjectName: ctx.subjectName, termName: ctx.termName, schemeExcerpt: ctx.schemeExcerpt,
        })
    );

    let paper = previous;
    let imageCredits = 0;
    const notes = [];

    if (result.paper && Array.isArray(result.paper.sections) && result.paper.sections.length > 0) {
      // Every question gets an id now, so what the AI asked for (a picture, one of the
      // teacher's images) can be matched to it after the paper is rebuilt.
      const wanted = new Map();
      const previousImage = new Map(
        (previous?.sections ?? []).flatMap((s) => s.questions.map((q) => [q.id, q.imageKey]))
      );
      const seenIds = new Set();
      for (const section of result.paper.sections) {
        for (const q of section.questions || []) {
          if (typeof q.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(q.id) || seenIds.has(q.id)) q.id = newId("q");
          seenIds.add(q.id);
          const idx = Number(q.attachmentIndex);
          if (Number.isInteger(idx) && idx >= 1 && idx <= attachmentKeys.length) q.imageKey = attachmentKeys[idx - 1];
          else if (typeof q.imagePrompt === "string" && q.imagePrompt.trim()) wanted.set(q.id, q.imagePrompt.trim().slice(0, 600));
          else if (previousImage.get(q.id)) q.imageKey = previousImage.get(q.id);
        }
      }

      const normalized = normalizePaper(result.paper, {
        imagePrefix: imagePrefix(chat.schoolId, chat.id),
        previous,
        fallbackTitle: chat.title,
      });
      paper = normalized.paper;

      // Draw the diagrams the AI asked for, each billed on its own and refunded if it cannot be drawn.
      let drawn = 0;
      for (const section of paper.sections) {
        for (const q of section.questions) {
          const prompt = wanted.get(q.id);
          if (!prompt) continue;
          if (drawn >= MAX_GENERATED_IMAGES_PER_TURN || normalized.imageCount + drawn >= LIMITS.images) {
            notes.push("Some diagrams were skipped: ask again for the rest.");
            break;
          }
          let reserved = null;
          try {
            ({ reserved } = await AiCreditService.reserveCredits(req.schoolId, AiCreditService.CREDITS_PER_GENERATED_IMAGE));
            const image = await ExamPaperAi.generateImage(prompt);
            q.imageKey = await storeImage(chat, image.buffer);
            imageCredits += reserved;
            drawn += 1;
          } catch (error) {
            if (reserved) await AiCreditService.refundCredits(req.schoolId, reserved).catch(() => null);
            const out = error?.statusCode ? error.message : `The diagram for a question could not be drawn (${error.message}).`;
            notes.push(out);
          }
        }
      }

      await prisma.examPaperChat.update({ where: { id: chat.id }, data: { paperJson: JSON.stringify(paper) } });
    }

    const reply = [result.reply, ...notes].filter(Boolean).join("\n\n") || "Done.";
    await prisma.examPaperChatMessage.createMany({
      data: [
        { chatId: chat.id, role: "user", content: text, attachmentsJson: attachmentKeys.length ? JSON.stringify(attachmentKeys) : null },
        {
          chatId: chat.id, role: "model", content: reply,
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, creditsCharged: charged + imageCredits,
        },
      ],
    });

    res.status(200).json({
      success: true,
      data: {
        reply,
        paperChanged: paper !== previous,
        paper: await withUrls(paper),
        attachments: await Promise.all(attachmentKeys.map((k) => r2.getPresignedUrl(k).catch(() => null))),
        creditsCharged: charged + imageCredits,
      },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/** PATCH /api/teacher/exam-papers/:id/paper  Body: { paper } — the teacher's own edits. */
exports.savePaper = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    if (!req.body?.paper || typeof req.body.paper !== "object") {
      throw new ChatError(400, "The paper is missing", "INVALID_REQUEST");
    }
    const { paper } = normalizePaper(req.body.paper, {
      imagePrefix: imagePrefix(chat.schoolId, chat.id),
      previous: parsePaper(chat.paperJson),
      fallbackTitle: chat.title,
    });
    await prisma.examPaperChat.update({ where: { id: chat.id }, data: { paperJson: JSON.stringify(paper), title: paper.title.slice(0, 255) } });
    res.json({ success: true, data: { paper: await withUrls(paper) } });
  } catch (error) {
    fail(error, res, next);
  }
};

/** POST /api/teacher/exam-papers/:id/images  (multipart: image) — returns the key to put on a question. */
exports.uploadImage = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    if (!req.file) throw new ChatError(400, "Attach an image", "INVALID_REQUEST");
    const key = await storeImage(chat, req.file.buffer);
    res.status(201).json({ success: true, data: { imageKey: key, imageUrl: await r2.getPresignedUrl(key).catch(() => null) } });
  } catch (error) {
    fail(error, res, next);
  }
};

/** GET /api/teacher/exam-papers/:id/paper.pdf?answers=1&inline=1 */
exports.pdf = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    const paper = parsePaper(chat.paperJson);
    if (!paper || questionCount(paper) === 0) throw new ChatError(409, "There are no questions to print yet.", "EMPTY_PAPER");

    const ctx = await loadContext(req.schoolId, chat);
    const branding = await resolveBranding(prisma, { schoolId: req.schoolId, campusId: ctx.campusId });
    const logoUrl = await schoolMediaUrl(branding.logoUrl);

    const images = new Map();
    for (const section of paper.sections) {
      for (const q of section.questions) {
        if (q.imageKey && !images.has(q.imageKey)) {
          const bytes = await r2.getObjectBuffer(q.imageKey).catch(() => null);
          if (bytes) images.set(q.imageKey, bytes);
        }
      }
    }

    const buffer = await buildExamPaperPdf(paper, {
      school: { name: branding.name, logo: logoUrl ? await loadImage(logoUrl) : null },
      className: ctx.className,
      subjectName: ctx.subjectName,
      termName: ctx.termName,
      images,
      answers: req.query.answers === "1",
    });
    sendPdf(res, buffer, `${paper.title}${req.query.answers === "1" ? "-answers" : ""}`, { inline: req.query.inline === "1" });
  } catch (error) {
    fail(error, res, next);
  }
};
