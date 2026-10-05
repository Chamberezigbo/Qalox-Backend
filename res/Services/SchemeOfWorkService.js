const crypto = require("crypto");
const prisma = require("../util/prisma");
const logger = require("../config/logger");
const { AppError } = require("../util/AppError");
const r2Service = require("./R2Service");
const DocumentTextExtractionService = require("./DocumentTextExtractionService");
const AiCreditService = require("./AiCreditService");
const { getAiCreditsStatusForSchool } = require("../util/getAiCreditsAllowanceForSchool");
const { schoolMediaUrl } = require("../controller/public/publicController");
const { MAX_OUTPUT_TOKENS } = require("./GeminiProseService");

/**
 * Scheme of Work uploads: store the source file(s) in R2, pull their text out,
 * and keep exactly one active document per class + subject + term.
 *
 * The text is extracted once here rather than on every generation request, so
 * a teacher generating a lesson note never waits on R2 and a PDF parse, and a
 * photographed scheme is never re-read (and re-billed) for each note.
 */

/** Keeps the R2 key readable and collision-free without leaking path separators from the original filename. */
function buildSchemeKey(schoolId, originalname) {
  const safeName = originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `scheme-of-work/${schoolId}/${crypto.randomBytes(8).toString("hex")}-${safeName}`;
}

const isImage = (mimetype) => typeof mimetype === "string" && mimetype.startsWith("image/");

/**
 * Reads every uploaded page and joins the text in page order.
 *
 * Credits are only ever involved on the image path. The whole upload's
 * worst-case cost is reserved up front — reserving per page would let a school
 * be charged for pages 1-3 of a 10-page scheme and then blocked halfway,
 * leaving them a part-read document they still paid for. If they can't afford
 * the whole thing, it falls back to Tesseract for the whole thing instead,
 * which is free and still produces a usable document.
 *
 * @returns {Promise<{ text: string, method: string, creditsCharged: number }>}
 */
async function extractTextFromFiles(schoolId, files) {
  const imageFiles = files.filter((f) => isImage(f.mimetype));

  // PDF path — local, free, no AI.
  if (imageFiles.length === 0) {
    const texts = [];
    for (const file of files) {
      texts.push(await DocumentTextExtractionService.textFromPdf(file.buffer));
    }
    return { text: texts.join("\n\n"), method: "pdf_parse", creditsCharged: 0 };
  }

  // Image path — reserve for the worst case across every page before reading any.
  const perPageWorstCase = AiCreditService.creditsForTokens({
    inputTokens: AiCreditService.TOKENS_PER_IMAGE,
    outputTokens: MAX_OUTPUT_TOKENS,
  });
  const reservation = perPageWorstCase * imageFiles.length;

  let reserved = 0;
  let allowGemini = true;
  try {
    await AiCreditService.reserveCredits(schoolId, reservation);
    reserved = reservation;
  } catch (error) {
    // Out of credits, or AI isn't on this plan at all: read it with the free
    // local OCR rather than refusing the upload outright. The admin still gets
    // their scheme of work; it's just less accurate on handwriting.
    logger.info("[SCHEME_OF_WORK] Falling back to Tesseract, Gemini not affordable", {
      schoolId,
      reason: error.message,
    });
    allowGemini = false;
  }

  try {
    const texts = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let usedGemini = false;

    for (const file of files) {
      if (!isImage(file.mimetype)) {
        texts.push(await DocumentTextExtractionService.textFromPdf(file.buffer));
        continue;
      }
      const page = await DocumentTextExtractionService.textFromImage(
        file.buffer,
        file.mimetype,
        allowGemini
      );
      texts.push(page.text);
      usage.inputTokens += page.usage.inputTokens;
      usage.outputTokens += page.usage.outputTokens;
      if (page.method === "gemini_vision") usedGemini = true;
    }

    let creditsCharged = 0;
    if (reserved > 0) {
      if (usedGemini) {
        ({ charged: creditsCharged } = await AiCreditService.trueUpCredits(schoolId, reserved, usage));
      } else {
        // Reserved, but every page ended up on the free fallback anyway.
        await AiCreditService.refundCredits(schoolId, reserved);
      }
    }

    return {
      text: texts.join("\n\n"),
      method: usedGemini ? "gemini_vision" : "tesseract",
      creditsCharged,
    };
  } catch (error) {
    if (reserved > 0) await AiCreditService.refundCredits(schoolId, reserved);
    throw error;
  }
}

/**
 * Builds the 409 a duplicate upload is refused with. The existing document's
 * details go in the payload because the client offers "Replace" from here, and
 * the teacher needs to see whose scheme they would be replacing.
 */
async function buildDuplicateError(existing) {
  const [uploader, subject] = await Promise.all([
    existing.uploadedByStaffId
      ? prisma.staff.findUnique({
          where: { id: existing.uploadedByStaffId },
          select: { name: true },
        })
      : null,
    prisma.subject.findUnique({ where: { id: existing.subjectId }, select: { name: true } }),
  ]);

  // Staff carries one `name` field, not firstName/lastName.
  const uploadedBy = uploader?.name?.trim() || "a school admin";

  const error = new AppError(
    `A scheme of work for ${subject?.name ?? "this subject"} already exists for this class this term ("${existing.title}", uploaded by ${uploadedBy}). Replace it if you want to use a new document.`,
    409
  );
  error.code = "SCHEME_OF_WORK_EXISTS";
  error.details = {
    existing: {
      id: existing.id,
      title: existing.title,
      uploadedBy,
      createdAt: existing.createdAt,
    },
  };
  return error;
}

/**
 * Stores a new scheme of work.
 *
 * Exactly one active document per class + subject + term. A second upload is
 * refused with 409 SCHEME_OF_WORK_EXISTS unless replaceExisting is set, at
 * which point the previous row is archived rather than deleted so history
 * survives. Teachers share classes, so silently shadowing a colleague's upload
 * would make it ambiguous which document a generated note was grounded in.
 */
async function createSchemeOfWork({
  schoolId,
  classId,
  subjectId,
  academicTermId,
  title,
  files,
  uploadedByAdminId,
  uploadedByStaffId,
  replaceExisting = false,
}) {
  if (!files?.length) throw new AppError("Upload a PDF or at least one page photo", 400);
  if (!title?.trim()) throw new AppError("Title is required", 400);

  const [classExists, subjectExists, termExists] = await Promise.all([
    prisma.class.findFirst({ where: { id: classId, schoolId } }),
    prisma.subject.findFirst({ where: { id: subjectId, schoolId } }),
    prisma.academicTerm.findFirst({ where: { id: academicTermId, schoolId } }),
  ]);
  if (!classExists) throw new AppError("Class not found", 404);
  if (!subjectExists) throw new AppError("Subject not found", 404);
  if (!termExists) throw new AppError("Academic term not found", 404);

  const mixed = files.some((f) => isImage(f.mimetype)) && files.some((f) => !isImage(f.mimetype));
  if (mixed) {
    throw new AppError("Upload either one PDF or page photos — not both in the same upload", 400);
  }

  // Checked here, before extraction, because reading a photographed scheme
  // spends AI credits. Refusing after that would charge a school for a
  // document it was never allowed to store.
  if (!replaceExisting) {
    const existing = await prisma.schemeOfWork.findFirst({
      where: { schoolId, classId, subjectId, academicTermId, status: "active" },
    });
    if (existing) throw await buildDuplicateError(existing);
  }

  // Read the document before writing anything, so a scheme that can't be read
  // doesn't leave an empty row and orphaned R2 objects behind.
  const extraction = await extractTextFromFiles(schoolId, files);

  const uploaded = [];
  for (const [index, file] of files.entries()) {
    const key = buildSchemeKey(schoolId, file.originalname);
    await r2Service.uploadObject({ buffer: file.buffer, key, contentType: file.mimetype });
    uploaded.push({
      order: index,
      fileUrl: `r2:${key}`,
      fileName: file.originalname,
      fileSize: file.size ?? file.buffer.length,
      mimeType: file.mimetype,
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction: extraction and the R2 uploads above
    // take seconds, and a colleague's upload can land in that window. The
    // early check saves the credits; this one is what actually guarantees a
    // single active row.
    if (!replaceExisting) {
      const raced = await tx.schemeOfWork.findFirst({
        where: { schoolId, classId, subjectId, academicTermId, status: "active" },
      });
      if (raced) throw await buildDuplicateError(raced);
    }

    await tx.schemeOfWork.updateMany({
      where: { schoolId, classId, subjectId, academicTermId, status: "active" },
      data: { status: "archived" },
    });

    return tx.schemeOfWork.create({
      data: {
        schoolId,
        classId,
        subjectId,
        academicTermId,
        title: title.trim(),
        sourceType: files.some((f) => isImage(f.mimetype)) ? "images" : "pdf",
        extractionMethod: extraction.method,
        creditsCharged: extraction.creditsCharged,
        extractedText: extraction.text,
        extractedTextStatus: extraction.text.trim() ? "ready" : "failed",
        uploadedByAdminId: uploadedByAdminId ?? null,
        uploadedByStaffId: uploadedByStaffId ?? null,
        files: { create: uploaded },
      },
      include: { files: { orderBy: { order: "asc" } } },
    });
  });

  logger.info("[SCHEME_OF_WORK] Created", {
    schoolId,
    schemeOfWorkId: created.id,
    pages: uploaded.length,
    method: extraction.method,
    creditsCharged: extraction.creditsCharged,
  });

  return withResolvedFiles(created);
}

/** Resolves every stored "r2:<key>" into a fresh presigned URL — the raw value must never reach a client. */
async function withResolvedFiles(scheme) {
  if (!scheme) return scheme;
  return {
    ...scheme,
    files: await Promise.all(
      (scheme.files ?? []).map(async (f) => ({ ...f, fileUrl: await schoolMediaUrl(f.fileUrl) }))
    ),
  };
}

async function listSchemesOfWork(schoolId, { classId, subjectId, academicTermId, includeArchived } = {}) {
  const schemes = await prisma.schemeOfWork.findMany({
    where: {
      schoolId,
      ...(classId && { classId: Number(classId) }),
      ...(subjectId && { subjectId: Number(subjectId) }),
      ...(academicTermId && { academicTermId: Number(academicTermId) }),
      ...(includeArchived ? {} : { status: "active" }),
    },
    include: {
      files: { orderBy: { order: "asc" } },
      class: { select: { id: true, name: true, customName: true } },
      subject: { select: { id: true, name: true } },
      academicTerm: { select: { id: true, name: true } },
      // Teachers upload too, so an admin needs to see whose document this is.
      uploadedByStaff: { select: { id: true, name: true } },
      uploadedByAdmin: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // extractedText can be very large and no list view needs it.
  return Promise.all(
    schemes.map(async ({ extractedText, ...rest }) => ({
      ...(await withResolvedFiles(rest)),
      hasText: Boolean(extractedText?.trim()),
    }))
  );
}

async function getSchemeOfWork(schoolId, id) {
  const scheme = await prisma.schemeOfWork.findFirst({
    where: { id, schoolId },
    include: {
      files: { orderBy: { order: "asc" } },
      class: { select: { id: true, name: true, customName: true } },
      subject: { select: { id: true, name: true } },
      academicTerm: { select: { id: true, name: true } },
    },
  });
  if (!scheme) throw new AppError("Scheme of work not found", 404);
  return withResolvedFiles(scheme);
}

/**
 * The one a generation request is grounded in: whatever is currently active
 * for that class + subject + term.
 */
async function getActiveSchemeOfWork(schoolId, { classId, subjectId, academicTermId }) {
  return prisma.schemeOfWork.findFirst({
    where: { schoolId, classId, subjectId, academicTermId, status: "active" },
    orderBy: { createdAt: "desc" },
  });
}

async function deleteSchemeOfWork(schoolId, id) {
  const scheme = await prisma.schemeOfWork.findFirst({
    where: { id, schoolId },
    include: { files: true },
  });
  if (!scheme) throw new AppError("Scheme of work not found", 404);

  await prisma.schemeOfWork.delete({ where: { id } });

  // Best-effort cleanup; an orphaned R2 object is harmless next to a failed delete.
  for (const file of scheme.files) {
    if (file.fileUrl?.startsWith("r2:")) {
      await r2Service.deleteObject(file.fileUrl.slice(3)).catch((err) =>
        logger.warn("[SCHEME_OF_WORK] Failed to delete R2 object", { key: file.fileUrl, error: err.message })
      );
    }
  }

  logger.info("[SCHEME_OF_WORK] Deleted", { schoolId, schemeOfWorkId: id });
  return { deleted: true, id };
}

module.exports = {
  createSchemeOfWork,
  listSchemesOfWork,
  getSchemeOfWork,
  getActiveSchemeOfWork,
  deleteSchemeOfWork,
  getAiCreditsStatusForSchool,
  // Exported for the teacher controller, which builds its own scoped list
  // query but must still turn stored "r2:<key>" values into presigned URLs.
  withResolvedFiles,
};
