const crypto = require("crypto");
const prisma = require("../../util/prisma");
const logger = require("../../config/logger");
const AiCreditService = require("../../Services/AiCreditService");
const AiGenerationWorker = require("../../Services/AiGenerationWorker");
const GeminiTextService = require("../../Services/GeminiTextService");

/**
 * Chat with the AI about how a lesson note should be written.
 *
 * The flow is: start a chat (the AI asks its first question), talk, generate
 * (the existing asynchronous job, which receives the conversation as its brief),
 * then optionally refine the finished note by asking for changes.
 *
 * Money works per turn. Each turn reserves credits against its own worst case,
 * calls Gemini, and trues up to the real usage, or refunds in full if the call
 * fails. Chat turns are synchronous because they are short. Generating the note
 * is not, so it goes through the same job + polling path as the form-based
 * generator, and the credits for it are reserved when the job is created.
 */

/** Backstops against a loop or a stuck client; the credit balance is the real limit. */
const MAX_CHAT_MESSAGES = 30;
const MAX_REFINEMENTS = 10;
const MAX_CHATS_PER_DAY = 20;
const MAX_JOBS_PER_TEACHER_PER_DAY = 20;
const MAX_MESSAGE_CHARS = 1000;

/** A failure with an HTTP status and a code the client can branch on. */
class ChatError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function assertTeaches(staffId, classId, subjectId) {
  const taught = await prisma.teacherAssignment.findFirst({ where: { staffId, classId, subjectId } });
  if (!taught) throw new ChatError(403, "You do not teach this subject in this class", "NOT_YOUR_CLASS");
}

/** The active term and the readable scheme of work a chat has to be grounded in. */
async function findTermAndScheme(schoolId, classId, subjectId) {
  const term = await prisma.academicTerm.findFirst({
    where: { schoolId, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!term) throw new ChatError(400, "No active term is set for your school.", "NO_ACTIVE_TERM");

  const scheme = await prisma.schemeOfWork.findFirst({
    where: { schoolId, classId, subjectId, academicTermId: term.id, status: "active" },
    select: { id: true, extractedText: true, extractedTextStatus: true },
  });
  if (!scheme) {
    throw new ChatError(
      404,
      "No scheme of work has been uploaded for this class and subject this term. Upload one first, or ask your admin to.",
      "SCHEME_OF_WORK_NOT_FOUND"
    );
  }
  if (scheme.extractedTextStatus !== "ready") {
    throw new ChatError(
      400,
      "The scheme of work for this class and subject couldn't be read. Replace it with a PDF or clearer photos.",
      "SCHEME_OF_WORK_UNREADABLE"
    );
  }
  return { term, scheme };
}

const classLabel = (c) => (c?.customName ? `${c.name} — ${c.customName}` : c?.name || "");

/** The teacher's own chat, with what is needed to talk about it; 404 for anyone else's. */
async function loadChat(req) {
  const chat = await prisma.lessonNoteChat.findFirst({
    where: { id: Number(req.params.id), staffId: req.staffId, schoolId: req.schoolId },
    include: {
      schemeOfWork: { select: { extractedText: true } },
      class: { select: { name: true, customName: true } },
      subject: { select: { name: true } },
    },
  });
  if (!chat) throw new ChatError(404, "Chat not found", "CHAT_NOT_FOUND");
  return chat;
}

const visible = (messages) =>
  messages
    .filter((m) => m.kind !== "start")
    .map(({ id, role, kind, content, createdAt }) => ({ id, role, kind, content, createdAt }));

/**
 * Runs one billable AI call: reserve, call, settle.
 *
 * A failed call refunds its whole reservation, so the school is only ever
 * charged for a reply the teacher received. The reservation itself can throw
 * (not enough credits); that is left to propagate untouched, as it is not an AI
 * failure.
 *
 * @param {number} schoolId
 * @param {{ inputTokens: number, outputTokens: number }} estimate worst case for this call
 * @param {() => Promise<{ usage: { inputTokens: number, outputTokens: number } }>} call
 */
async function billedCall(schoolId, estimate, call) {
  const { reserved } = await AiCreditService.reserveCredits(schoolId, AiCreditService.creditsForTokens(estimate));

  let result;
  try {
    result = await call();
  } catch (error) {
    await AiCreditService.refundCredits(schoolId, reserved).catch((refundError) =>
      logger.error("[LESSON_NOTE_CHAT] Refund failed — school may be over-charged", {
        schoolId,
        reserved,
        error: refundError.message,
      })
    );
    logger.warn("[LESSON_NOTE_CHAT] AI call failed, credits refunded", { schoolId, error: error.message });
    throw new ChatError(502, error.message, "AI_FAILED");
  }

  const { charged } = await AiCreditService.trueUpCredits(schoolId, reserved, result.usage);
  return { result, charged };
}

/** Turns a ChatError into its response and anything else into the error middleware. */
function fail(error, res, next) {
  if (error instanceof ChatError) {
    return res.status(error.status).json({ success: false, message: error.message, code: error.code, data: error.data });
  }
  // AppError from the credit check (not enough credits, no plan).
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: "CREDITS" });
  }
  logger.error("[LESSON_NOTE_CHAT] Request failed", { error: error.message });
  return next(error);
}

const chatEstimate = (excerpt, history) => ({
  inputTokens:
    AiCreditService.estimateTokensFromText(excerpt) +
    AiCreditService.estimateTokensFromText(history.map((m) => m.content).join(" ")) +
    700, // system prompt scaffold
  outputTokens: GeminiTextService.CHAT_MAX_OUTPUT_TOKENS,
});

const asHistory = (messages) => messages.map(({ role, content }) => ({ role, content }));

/**
 * POST /api/teacher/lesson-notes/chats
 * Body: { classId, subjectId, topic?, weekRange?, duration? }
 */
exports.startChat = async (req, res, next) => {
  try {
    const { staffId, schoolId } = req;
    const classId = Number(req.body.classId);
    const subjectId = Number(req.body.subjectId);
    const { topic, weekRange, duration } = req.body;

    if (!classId || !subjectId) {
      throw new ChatError(400, "classId and subjectId are required", "INVALID_REQUEST");
    }
    await assertTeaches(staffId, classId, subjectId);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if ((await prisma.lessonNoteChat.count({ where: { staffId, createdAt: { gte: since } } })) >= MAX_CHATS_PER_DAY) {
      throw new ChatError(429, `You've started ${MAX_CHATS_PER_DAY} chats today. Try again tomorrow.`, "DAILY_LIMIT_REACHED");
    }

    const { term, scheme } = await findTermAndScheme(schoolId, classId, subjectId);

    const [classRow, subjectRow] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId }, select: { name: true, customName: true } }),
      prisma.subject.findFirst({ where: { id: subjectId, schoolId }, select: { name: true } }),
    ]);

    // The opening message is invisible to the teacher: it only exists so the AI
    // has something to answer, and the answer is its first question.
    const opening = `I want to write a lesson note on ${topic || "the next topic in the scheme of work"}. Ask me what you need to know.`;
    const history = [{ role: "user", content: opening }];

    const { result, charged } = await billedCall(
      schoolId,
      chatEstimate(GeminiTextService.buildContextExcerpt(scheme.extractedText, topic), history),
      () =>
        GeminiTextService.chatTurn({
          history,
          schemeText: scheme.extractedText,
          className: classLabel(classRow),
          subjectName: subjectRow?.name || "",
          topic,
          weekRange,
          duration,
        })
    );

    // Created only now, after the AI answered: a failed start leaves nothing behind.
    const chat = await prisma.lessonNoteChat.create({
      data: {
        schoolId,
        staffId,
        classId,
        subjectId,
        academicTermId: term.id,
        schemeOfWorkId: scheme.id,
        topic: topic || null,
        weekRange: weekRange || null,
        duration: duration || null,
        messages: {
          create: [
            { role: "user", kind: "start", content: opening },
            {
              role: "model",
              kind: "chat",
              content: result.reply,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              creditsCharged: charged,
            },
          ],
        },
      },
      include: { messages: { orderBy: { id: "asc" } } },
    });

    return res.status(201).json({
      success: true,
      data: {
        chatId: chat.id,
        status: chat.status,
        messages: visible(chat.messages),
        readyToGenerate: result.readyToGenerate,
        creditsCharged: charged,
      },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/** GET /api/teacher/lesson-notes/chats/:id */
exports.getChat = async (req, res, next) => {
  try {
    const chat = await loadChat(req);
    const messages = await prisma.lessonNoteChatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { id: "asc" },
    });
    return res.status(200).json({
      success: true,
      data: {
        chatId: chat.id,
        status: chat.status,
        lessonNoteId: chat.lessonNoteId,
        classId: chat.classId,
        subjectId: chat.subjectId,
        topic: chat.topic,
        messages: visible(messages),
      },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * POST /api/teacher/lesson-notes/chats/:id/messages
 * Body: { message }
 */
exports.sendMessage = async (req, res, next) => {
  try {
    const text = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!text) throw new ChatError(400, "Write a message first.", "INVALID_REQUEST");
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new ChatError(400, `Keep each message under ${MAX_MESSAGE_CHARS} characters.`, "MESSAGE_TOO_LONG");
    }

    const chat = await loadChat(req);
    if (chat.status === "generated") {
      throw new ChatError(409, "This note is already written. Use the refine box to change it.", "CHAT_FINISHED");
    }
    if (chat.status === "generating") {
      throw new ChatError(409, "Your note is being written. Wait for it to finish.", "GENERATION_IN_PROGRESS");
    }

    const messages = await prisma.lessonNoteChatMessage.findMany({
      where: { chatId: chat.id, kind: { in: ["start", "chat"] } },
      orderBy: { id: "asc" },
    });
    if (messages.filter((m) => m.role === "user" && m.kind === "chat").length >= MAX_CHAT_MESSAGES) {
      throw new ChatError(429, "This chat has reached its length limit. Generate your note from it now.", "CHAT_LIMIT_REACHED");
    }

    const history = [...asHistory(messages), { role: "user", content: text }];

    const { result, charged } = await billedCall(
      req.schoolId,
      chatEstimate(GeminiTextService.buildContextExcerpt(chat.schemeOfWork.extractedText, chat.topic), history),
      () =>
        GeminiTextService.chatTurn({
          history,
          schemeText: chat.schemeOfWork.extractedText,
          className: classLabel(chat.class),
          subjectName: chat.subject?.name || "",
          topic: chat.topic,
          weekRange: chat.weekRange,
          duration: chat.duration,
        })
    );

    // Both sides saved together and only on success, so the stored history always
    // alternates and a failed turn leaves no unanswered message behind.
    await prisma.lessonNoteChatMessage.createMany({
      data: [
        { chatId: chat.id, role: "user", kind: "chat", content: text },
        {
          chatId: chat.id,
          role: "model",
          kind: "chat",
          content: result.reply,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          creditsCharged: charged,
        },
      ],
    });

    return res.status(200).json({
      success: true,
      data: { reply: result.reply, readyToGenerate: result.readyToGenerate, creditsCharged: charged },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * POST /api/teacher/lesson-notes/chats/:id/generate
 * Writes the note from the conversation. Asynchronous, polled through the
 * existing GET /lesson-notes/generate/:jobId.
 */
exports.generateFromChat = async (req, res, next) => {
  try {
    const { staffId, schoolId } = req;
    const chat = await loadChat(req);

    if (chat.status === "generated") {
      throw new ChatError(409, "This note is already written. Use the refine box to change it.", "CHAT_FINISHED", {
        lessonNoteId: chat.lessonNoteId,
      });
    }

    const inFlight = await prisma.aiGenerationJob.findFirst({
      where: { staffId, status: { in: ["queued", "processing"] } },
      select: { id: true },
    });
    if (inFlight) {
      throw new ChatError(
        409,
        "You already have a generation running. Wait for it to finish before starting another.",
        "GENERATION_IN_PROGRESS",
        { jobId: inFlight.id }
      );
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if ((await prisma.aiGenerationJob.count({ where: { staffId, createdAt: { gte: since } } })) >= MAX_JOBS_PER_TEACHER_PER_DAY) {
      throw new ChatError(
        429,
        `You've reached the daily limit of ${MAX_JOBS_PER_TEACHER_PER_DAY} generations. Try again tomorrow.`,
        "DAILY_LIMIT_REACHED"
      );
    }

    const scheme = await prisma.schemeOfWork.findFirst({
      where: { id: chat.schemeOfWorkId, status: "active" },
      select: { id: true, extractedText: true, extractedTextStatus: true },
    });
    if (!scheme || scheme.extractedTextStatus !== "ready") {
      throw new ChatError(400, "The scheme of work for this chat is no longer available. Start a new chat.", "SCHEME_OF_WORK_UNREADABLE");
    }

    // The conversation travels with the prompt, so it counts towards the reservation.
    const messages = await prisma.lessonNoteChatMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { id: "asc" },
      select: { role: true, kind: true, content: true },
    });
    const brief = GeminiTextService.buildTeacherBrief(messages);

    const excerpt = GeminiTextService.buildContextExcerpt(scheme.extractedText, chat.topic);
    const estimatedInputTokens =
      AiCreditService.estimateTokensFromText(excerpt) + AiCreditService.estimateTokensFromText(brief) + 500;
    const estimatedOutputTokens = GeminiTextService.LESSON_NOTE_MAX_OUTPUT_TOKENS;

    const { reserved } = await AiCreditService.reserveCredits(
      schoolId,
      AiCreditService.creditsForTokens({ inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens })
    );

    let job;
    try {
      job = await prisma.aiGenerationJob.create({
        data: {
          id: `aig_${crypto.randomBytes(12).toString("hex")}`,
          schoolId,
          staffId,
          jobType: "lesson_note",
          schemeOfWorkId: scheme.id,
          classId: chat.classId,
          subjectId: chat.subjectId,
          academicTermId: chat.academicTermId,
          inputParamsJson: JSON.stringify({
            topic: chat.topic,
            weekRange: chat.weekRange,
            duration: chat.duration,
            chatId: chat.id,
          }),
          status: "queued",
          model: GeminiTextService.getModel(),
          estimatedInputTokens,
          estimatedOutputTokens,
          creditsReserved: reserved,
        },
      });
      await prisma.lessonNoteChat.update({ where: { id: chat.id }, data: { status: "generating" } });
    } catch (error) {
      await AiCreditService.refundCredits(schoolId, reserved).catch(() => {});
      throw error;
    }

    setImmediate(() => {
      AiGenerationWorker.processJob({ jobId: job.id }).catch((error) => {
        logger.error("[LESSON_NOTE_CHAT] Worker crashed", { jobId: job.id, error: error.message });
      });
    });

    return res.status(202).json({
      success: true,
      message: "Generation started",
      data: { jobId: job.id, creditsReserved: reserved },
    });
  } catch (error) {
    fail(error, res, next);
  }
};

/**
 * POST /api/teacher/lesson-notes/chats/:id/refine
 * Body: { instruction }
 * Rewrites the finished note as asked. The saved version is what gets revised,
 * so the client saves any unsaved edits first.
 */
exports.refineNote = async (req, res, next) => {
  try {
    const instruction = typeof req.body.instruction === "string" ? req.body.instruction.trim() : "";
    if (!instruction) throw new ChatError(400, "Say what you'd like changed.", "INVALID_REQUEST");
    if (instruction.length > MAX_MESSAGE_CHARS) {
      throw new ChatError(400, `Keep each request under ${MAX_MESSAGE_CHARS} characters.`, "MESSAGE_TOO_LONG");
    }

    const chat = await loadChat(req);
    if (chat.status !== "generated" || !chat.lessonNoteId) {
      throw new ChatError(409, "Write the note first, then you can ask for changes.", "NOTE_NOT_READY");
    }

    const note = await prisma.lessonNote.findFirst({
      where: { id: chat.lessonNoteId, staffId: req.staffId },
    });
    if (!note) throw new ChatError(404, "Lesson note not found", "NOTE_NOT_FOUND");

    const used = await prisma.lessonNoteChatMessage.count({ where: { chatId: chat.id, kind: "refine", role: "user" } });
    if (used >= MAX_REFINEMENTS) {
      throw new ChatError(429, "You've used all the changes available for this note. You can still edit it by hand.", "REFINE_LIMIT_REACHED");
    }

    let objectives = [];
    try {
      objectives = JSON.parse(note.objectivesJson || "[]");
    } catch {
      // Unreadable objectives are treated as none rather than blocking the change.
    }

    const excerpt = GeminiTextService.buildContextExcerpt(chat.schemeOfWork.extractedText, chat.topic);
    const { result, charged } = await billedCall(
      req.schoolId,
      {
        inputTokens:
          AiCreditService.estimateTokensFromText(excerpt) +
          AiCreditService.estimateTokensFromText(note.content) +
          AiCreditService.estimateTokensFromText(instruction) +
          500,
        outputTokens: GeminiTextService.LESSON_NOTE_MAX_OUTPUT_TOKENS,
      },
      () =>
        GeminiTextService.refineNote({
          schemeText: chat.schemeOfWork.extractedText,
          className: classLabel(chat.class),
          subjectName: chat.subject?.name || "",
          topic: chat.topic,
          note: { title: note.title, objectives, content: note.content },
          instruction,
        })
    );

    const updated = await prisma.lessonNote.update({
      where: { id: note.id },
      data: {
        title: result.parsed.title,
        objectivesJson: JSON.stringify(result.parsed.objectives),
        content: result.parsed.content,
      },
    });

    await prisma.lessonNoteChatMessage.createMany({
      data: [
        { chatId: chat.id, role: "user", kind: "refine", content: instruction },
        {
          chatId: chat.id,
          role: "model",
          kind: "refine",
          content: "Done — I've updated the note.",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          creditsCharged: charged,
        },
      ],
    });

    return res.status(200).json({ success: true, data: { note: updated, creditsCharged: charged } });
  } catch (error) {
    fail(error, res, next);
  }
};

exports.ChatError = ChatError;
exports.MAX_CHAT_MESSAGES = MAX_CHAT_MESSAGES;
exports.MAX_REFINEMENTS = MAX_REFINEMENTS;
