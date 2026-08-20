const prisma = require("../util/prisma");
const { AppError } = require("../util/AppError");

const WORKING_DAYS = [1, 2, 3, 4, 5]; // Mon-Fri (Date#getUTCDay: 0=Sun, 6=Sat)

async function assertCampusAndSessionBelongToSchool(schoolId, campusId, academicSessionId) {
  const [campus, session] = await Promise.all([
    prisma.campus.findFirst({ where: { id: campusId, schoolId } }),
    prisma.academicSession.findFirst({ where: { id: academicSessionId, schoolId } }),
  ]);
  if (!campus) throw new AppError("Invalid campusId for this school", 400);
  if (!session) throw new AppError("Invalid academicSessionId for this school", 400);
}

async function getOwnedSchedule(schoolId, id) {
  const schedule = await prisma.examSchedule.findFirst({ where: { id: Number(id), schoolId } });
  if (!schedule) throw new AppError("Exam schedule not found", 404);
  return schedule;
}

async function assertClassesAndSubjectsBelongToSchool(schoolId, entries) {
  const classIds = [...new Set(entries.map((e) => e.classId))];
  const subjectIds = [...new Set(entries.map((e) => e.subjectId))];
  const [classes, subjects] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds }, schoolId }, select: { id: true } }),
    prisma.subject.findMany({ where: { id: { in: subjectIds }, schoolId }, select: { id: true } }),
  ]);
  const validClassIds = new Set(classes.map((c) => c.id));
  const validSubjectIds = new Set(subjects.map((s) => s.id));
  for (const e of entries) {
    if (!validClassIds.has(e.classId)) throw new AppError(`classId ${e.classId} does not belong to this school`, 400);
    if (!validSubjectIds.has(e.subjectId)) throw new AppError(`subjectId ${e.subjectId} does not belong to this school`, 400);
  }
}

// Same class, same date+time twice = a student can't sit two exams at once.
function findClashes(entries) {
  const seen = new Map();
  const clashes = [];
  for (const e of entries) {
    const key = `${e.classId}|${e.date}|${e.startTime}`;
    if (seen.has(key)) {
      clashes.push({ classId: e.classId, date: e.date, startTime: e.startTime });
    } else {
      seen.set(key, e);
    }
  }
  return clashes;
}

function toDateOnlyString(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date;
}

exports.createSchedule = async (schoolId, adminId, body) => {
  const { campusId, academicSessionId, examType, name, description, schedulingMethod } = body;
  await assertCampusAndSessionBelongToSchool(schoolId, campusId, academicSessionId);

  return prisma.examSchedule.create({
    data: {
      schoolId,
      campusId,
      academicSessionId,
      examType,
      name,
      description: description || null,
      schedulingMethod,
      createdByAdminId: adminId,
    },
  });
};

exports.updateScheduleHeader = async (schoolId, id, body) => {
  const existing = await getOwnedSchedule(schoolId, id);
  if (existing.status === "published") {
    throw new AppError("Cannot edit a published exam schedule", 400);
  }

  if (body.campusId || body.academicSessionId) {
    await assertCampusAndSessionBelongToSchool(
      schoolId,
      body.campusId ?? existing.campusId,
      body.academicSessionId ?? existing.academicSessionId
    );
  }

  return prisma.examSchedule.update({ where: { id: existing.id }, data: body });
};

exports.getSchedule = async (schoolId, id) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  const entries = await prisma.examScheduleEntry.findMany({
    where: { examScheduleId: schedule.id },
    include: {
      class: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  return { ...schedule, entries };
};

exports.listSchedules = async (schoolId, { campusId, academicSessionId, status } = {}) => {
  return prisma.examSchedule.findMany({
    where: {
      schoolId,
      ...(campusId && { campusId: Number(campusId) }),
      ...(academicSessionId && { academicSessionId: Number(academicSessionId) }),
      ...(status && { status }),
    },
    include: {
      _count: { select: { entries: true } },
      campus: { select: { id: true, name: true } },
      academicSession: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
};

exports.deleteSchedule = async (schoolId, id) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  if (schedule.status === "published") {
    throw new AppError("Cannot delete a published exam schedule", 400);
  }
  await prisma.examSchedule.delete({ where: { id: schedule.id } });
  return { deleted: true };
};

exports.replaceEntries = async (schoolId, id, entries) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  if (schedule.status === "published") {
    throw new AppError("Cannot edit entries of a published exam schedule", 400);
  }

  await assertClassesAndSubjectsBelongToSchool(schoolId, entries);

  const clashes = findClashes(entries);
  if (clashes.length > 0) {
    const summary = clashes.map((c) => `class ${c.classId} on ${c.date} at ${c.startTime}`).join("; ");
    throw new AppError(`Scheduling conflict — a class already has an exam at the same date/time: ${summary}`, 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.examScheduleEntry.deleteMany({ where: { examScheduleId: schedule.id } });
    await tx.examScheduleEntry.createMany({
      data: entries.map((e) => ({
        examScheduleId: schedule.id,
        classId: e.classId,
        subjectId: e.subjectId,
        date: new Date(`${e.date}T00:00:00Z`),
        startTime: e.startTime,
        durationMinutes: e.durationMinutes,
      })),
    });
    return tx.examScheduleEntry.findMany({ where: { examScheduleId: schedule.id } });
  });
};

exports.updateEntry = async (schoolId, id, entryId, patch) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  if (schedule.status === "published") {
    throw new AppError("Cannot edit entries of a published exam schedule", 400);
  }

  const entry = await prisma.examScheduleEntry.findFirst({
    where: { id: Number(entryId), examScheduleId: schedule.id },
  });
  if (!entry) throw new AppError("Exam schedule entry not found", 404);

  const merged = {
    classId: entry.classId,
    date: patch.date ?? toDateOnlyString(entry.date),
    startTime: patch.startTime ?? entry.startTime,
  };

  const others = await prisma.examScheduleEntry.findMany({
    where: { examScheduleId: schedule.id, id: { not: entry.id } },
  });
  const othersFormatted = others.map((o) => ({
    classId: o.classId,
    date: toDateOnlyString(o.date),
    startTime: o.startTime,
  }));

  if (findClashes([...othersFormatted, merged]).length > 0) {
    throw new AppError("Scheduling conflict — this class already has an exam at that date/time", 400);
  }

  return prisma.examScheduleEntry.update({
    where: { id: entry.id },
    data: {
      ...(patch.date && { date: new Date(`${patch.date}T00:00:00Z`) }),
      ...(patch.startTime && { startTime: patch.startTime }),
      ...(patch.durationMinutes && { durationMinutes: patch.durationMinutes }),
    },
  });
};

exports.deleteEntry = async (schoolId, id, entryId) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  if (schedule.status === "published") {
    throw new AppError("Cannot edit entries of a published exam schedule", 400);
  }

  const entry = await prisma.examScheduleEntry.findFirst({
    where: { id: Number(entryId), examScheduleId: schedule.id },
  });
  if (!entry) throw new AppError("Exam schedule entry not found", 404);

  await prisma.examScheduleEntry.delete({ where: { id: entry.id } });
  return { deleted: true };
};

function nextWorkingDay(date) {
  const d = new Date(date);
  while (!WORKING_DAYS.includes(d.getUTCDay())) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// Greedy round-robin: each class works through its own subject queue one
// slot at a time. Within a day, every class advances through sequential
// time slots (start + duration + break, repeating) up to `examsPerDay`; once
// every class is either empty or capped for the day, the schedule advances
// to the next working day. Clash-free by construction — a class only ever
// gets one entry per (day, slot) — so no solver is needed.
exports.autoGenerate = ({ classSubjectPairs, firstExamDate, defaultStartTime, durationMinutes, breakMinutes, examsPerDay }) => {
  const queues = new Map();
  const classOrder = [];
  for (const { classId, subjectId } of classSubjectPairs) {
    if (!queues.has(classId)) {
      queues.set(classId, []);
      classOrder.push(classId);
    }
    queues.get(classId).push(subjectId);
  }

  const cap = examsPerDay ?? Infinity;
  let day = nextWorkingDay(new Date(`${firstExamDate}T00:00:00Z`));
  const entries = [];

  const hasRemaining = () => classOrder.some((c) => queues.get(c).length > 0);

  while (hasRemaining()) {
    const dailyCount = new Map(classOrder.map((c) => [c, 0]));
    const slotCursor = new Map(classOrder.map((c) => [c, 0]));

    let progressedToday = true;
    while (progressedToday) {
      progressedToday = false;
      for (const classId of classOrder) {
        const queue = queues.get(classId);
        if (queue.length === 0) continue;
        if (dailyCount.get(classId) >= cap) continue;

        const slotIndex = slotCursor.get(classId);
        const startTime = addMinutes(defaultStartTime, slotIndex * (durationMinutes + breakMinutes));
        const subjectId = queue.shift();

        entries.push({ classId, subjectId, date: toDateOnlyString(day), startTime, durationMinutes });

        dailyCount.set(classId, dailyCount.get(classId) + 1);
        slotCursor.set(classId, slotIndex + 1);
        progressedToday = true;
      }
    }

    if (hasRemaining()) {
      day = nextWorkingDay(new Date(day.getTime() + 24 * 60 * 60 * 1000));
    }
  }

  return entries;
};

// Best-effort: syncs scheduledDate onto existing (CA-template-generated) Exam
// rows that match this schedule's entries by classId+subjectId+name. Never
// creates new Exam rows — those need maxScore/weightage from the grading
// flow, which this wizard has no business inventing.
exports.publish = async (schoolId, id) => {
  const schedule = await getOwnedSchedule(schoolId, id);
  if (schedule.status === "published") {
    throw new AppError("Exam schedule is already published", 400);
  }

  const entries = await prisma.examScheduleEntry.findMany({ where: { examScheduleId: schedule.id } });
  if (entries.length === 0) {
    throw new AppError("Cannot publish an exam schedule with no entries", 400);
  }

  let matchedExamCount = 0;
  for (const entry of entries) {
    const matchedExam = await prisma.exam.findFirst({
      where: { classId: entry.classId, subjectId: entry.subjectId, name: schedule.name, class: { schoolId } },
    });

    if (matchedExam) {
      matchedExamCount += 1;
      await Promise.all([
        prisma.exam.update({ where: { id: matchedExam.id }, data: { scheduledDate: entry.date } }),
        prisma.examScheduleEntry.update({ where: { id: entry.id }, data: { linkedExamId: matchedExam.id } }),
      ]);
    }
  }

  const published = await prisma.examSchedule.update({
    where: { id: schedule.id },
    data: { status: "published", publishedAt: new Date() },
  });

  return { ...published, matchedExamCount, unmatchedCount: entries.length - matchedExamCount };
};
