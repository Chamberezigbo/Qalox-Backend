const crypto = require("crypto");
const prisma = require("../util/prisma");
const r2 = require("./R2Service");
const { AppError } = require("../util/AppError");

/**
 * In-app chat between staff, and between staff and their own students.
 *
 * One service for every portal: callers pass who they are as `{ type: "STAFF" | "STUDENT", id, schoolId }`.
 * Who may talk to whom lives in ONE place (`canChat`) and is checked when a thread is opened and again on
 * every message, so the contact list the app shows and what the API allows can never disagree.
 */

const STAFF = "STAFF";
const STUDENT = "STUDENT";
const MAX_BODY = 2000;
const PAGE_SIZE = 40;
const RATE_LIMIT = 30; // messages per sender per minute
const RATE_WINDOW_MS = 60 * 1000;

const sentRecently = new Map(); // "STAFF:3" -> [timestamps]

const keyOf = (who) => `${who.type}:${who.id}`;
const pairKeyOf = (a, b) => [keyOf(a), keyOf(b)].sort().join("|");
const studentFullName = (s) => [s.name, s.surname].filter(Boolean).join(" ");

function checkRate(who, now = Date.now()) {
  const key = keyOf(who);
  const recent = (sentRecently.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) throw new AppError("You are sending messages too fast. Wait a moment and try again.", 429);
  recent.push(now);
  sentRecently.set(key, recent);
}

/** The person in this school, or null. A withdrawn student cannot chat. */
async function loadPerson(who, schoolId) {
  if (who.type === STAFF) {
    const staff = await prisma.staff.findFirst({ where: { id: who.id, schoolId }, select: { id: true, name: true, duty: true, campusId: true } });
    return staff ? { type: STAFF, id: staff.id, name: staff.name, subtitle: staff.duty || "Staff", campusId: staff.campusId } : null;
  }
  if (who.type === STUDENT) {
    const student = await prisma.student.findFirst({
      where: { id: who.id, schoolId, status: "active" },
      select: { id: true, name: true, surname: true, classId: true, campusId: true, class: { select: { name: true, campusId: true } } },
    });
    return student
      ? { type: STUDENT, id: student.id, name: studentFullName(student), subtitle: student.class?.name || "Student", classId: student.classId, campusId: student.campusId ?? student.class?.campusId ?? null }
      : null;
  }
  return null;
}

/** Does this staff member teach the class, as class teacher or by assignment? */
async function teachesClass(staffId, classId) {
  const [asClassTeacher, assignment] = await Promise.all([
    prisma.class.findFirst({ where: { id: classId, staffId }, select: { id: true } }),
    prisma.teacherAssignment.findFirst({ where: { staffId, classId }, select: { id: true } }),
  ]);
  return Boolean(asClassTeacher || assignment);
}

/**
 * The single rule for who may chat. `a` and `b` come from loadPerson (so they are in the school and,
 * for students, active). Returns { ok: true } or { ok: false, reason }.
 */
async function canChat(a, b, school) {
  if (!a || !b) return { ok: false, reason: "That person was not found in your school." };
  if (a.type === b.type && a.id === b.id) return { ok: false, reason: "You cannot chat with yourself." };
  if (a.type === STUDENT && b.type === STUDENT) return { ok: false, reason: "Students cannot chat with each other." };
  if (a.type === STAFF && b.type === STAFF) return { ok: true };

  const staff = a.type === STAFF ? a : b;
  const student = a.type === STUDENT ? a : b;
  if (!school.chatStudentsEnabled) return { ok: false, reason: "Chat with students is switched off for this school." };
  if (!(await teachesClass(staff.id, student.classId))) return { ok: false, reason: "You can only chat with students you teach." };
  return { ok: true };
}

const loadSchool = async (schoolId) => {
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, chatStudentsEnabled: true } });
  if (!school) throw new AppError("School not found", 404);
  return school;
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** Everyone `me` may start a chat with, grouped for the picker. */
async function listContacts(me, search = "") {
  const school = await loadSchool(me.schoolId);
  const self = await loadPerson(me, me.schoolId);
  if (!self) throw new AppError("Account not found", 404);
  const term = String(search || "").trim().toLowerCase();
  const matches = (name) => !term || name.toLowerCase().includes(term);

  if (me.type === STAFF) {
    const colleagues = await prisma.staff.findMany({ where: { schoolId: me.schoolId, id: { not: me.id } }, select: { id: true, name: true, duty: true }, orderBy: { name: "asc" } });
    let students = [];
    if (school.chatStudentsEnabled) {
      const [assignments, owned] = await Promise.all([
        prisma.teacherAssignment.findMany({ where: { staffId: me.id, classId: { not: null } }, select: { classId: true } }),
        prisma.class.findMany({ where: { staffId: me.id, schoolId: me.schoolId }, select: { id: true } }),
      ]);
      const classIds = [...new Set([...assignments.map((a) => a.classId), ...owned.map((c) => c.id)])];
      if (classIds.length > 0) {
        const rows = await prisma.student.findMany({
          where: { schoolId: me.schoolId, status: "active", classId: { in: classIds } },
          select: { id: true, name: true, surname: true, class: { select: { name: true } } },
          orderBy: { name: "asc" },
        });
        students = rows.map((s) => ({ type: STUDENT, id: s.id, name: studentFullName(s), subtitle: s.class?.name || "Student" }));
      }
    }
    return {
      colleagues: colleagues.map((s) => ({ type: STAFF, id: s.id, name: s.name, subtitle: s.duty || "Staff" })).filter((c) => matches(c.name)),
      students: students.filter((c) => matches(c.name)),
    };
  }

  // A student: only the teachers of their own class.
  if (!school.chatStudentsEnabled) return { colleagues: [], students: [], teachers: [], disabled: true };
  const [assignments, classRow] = await Promise.all([
    prisma.teacherAssignment.findMany({ where: { classId: self.classId }, select: { staffId: true } }),
    prisma.class.findFirst({ where: { id: self.classId }, select: { staffId: true } }),
  ]);
  const staffIds = [...new Set([...assignments.map((a) => a.staffId), classRow?.staffId].filter(Boolean))];
  const teachers = staffIds.length ? await prisma.staff.findMany({ where: { schoolId: me.schoolId, id: { in: staffIds } }, select: { id: true, name: true, duty: true }, orderBy: { name: "asc" } }) : [];
  return { colleagues: [], students: [], teachers: teachers.map((s) => ({ type: STAFF, id: s.id, name: s.name, subtitle: s.duty || "Teacher" })).filter((c) => matches(c.name)) };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Names for a set of participants, in one query per kind. */
async function namesFor(participants) {
  const staffIds = participants.filter((p) => p.userType === STAFF).map((p) => p.userId);
  const studentIds = participants.filter((p) => p.userType === STUDENT).map((p) => p.userId);
  const [staff, students] = await Promise.all([
    staffIds.length ? prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true, duty: true } }) : [],
    studentIds.length ? prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true, surname: true, class: { select: { name: true } } } }) : [],
  ]);
  const map = new Map();
  staff.forEach((s) => map.set(`${STAFF}:${s.id}`, { type: STAFF, id: s.id, name: s.name, subtitle: s.duty || "Staff" }));
  students.forEach((s) => map.set(`${STUDENT}:${s.id}`, { type: STUDENT, id: s.id, name: studentFullName(s), subtitle: s.class?.name || "Student" }));
  return map;
}

/** Unread messages per conversation for `me`, as Map(conversationId -> count). */
async function unreadByConversation(me, conversationIds) {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT m.conversationId AS conversationId, COUNT(*) AS unread
    FROM chat_messages m
    JOIN chat_participants p ON p.conversationId = m.conversationId AND p.userType = ${me.type} AND p.userId = ${me.id}
    WHERE m.id > p.lastReadMessageId AND NOT (m.senderType = ${me.type} AND m.senderId = ${me.id})
    GROUP BY m.conversationId`;
  return new Map(rows.map((r) => [Number(r.conversationId), Number(r.unread)]));
}

/** Opens (or reuses) the one thread between `me` and `other`. */
async function openConversation(me, other) {
  const school = await loadSchool(me.schoolId);
  const [self, target] = await Promise.all([loadPerson(me, me.schoolId), loadPerson(other, me.schoolId)]);
  const verdict = await canChat(self, target, school);
  if (!verdict.ok) throw new AppError(verdict.reason, 403);

  const pairKey = pairKeyOf(self, target);
  const find = () => prisma.chatConversation.findUnique({ where: { schoolId_pairKey: { schoolId: me.schoolId, pairKey } } });
  let conversation = await find();
  if (!conversation) {
    const student = self.type === STUDENT ? self : target.type === STUDENT ? target : null;
    try {
      conversation = await prisma.chatConversation.create({
        data: {
          schoolId: me.schoolId,
          campusId: student ? student.campusId : null,
          kind: student ? "STAFF_STUDENT" : "STAFF_STAFF",
          pairKey,
          participants: { create: [{ userType: self.type, userId: self.id }, { userType: target.type, userId: target.id }] },
        },
      });
    } catch (err) {
      if (err?.code !== "P2002") throw err; // two people opened it at the same moment: use the one that won
      conversation = await find();
    }
  }
  return { id: conversation.id, with: { type: target.type, id: target.id, name: target.name, subtitle: target.subtitle } };
}

async function listConversations(me) {
  const mine = await prisma.chatParticipant.findMany({ where: { userType: me.type, userId: me.id, conversation: { schoolId: me.schoolId } }, select: { conversationId: true } });
  const ids = mine.map((p) => p.conversationId);
  if (ids.length === 0) return [];

  const conversations = await prisma.chatConversation.findMany({
    where: { id: { in: ids }, lastMessageAt: { not: null } },
    include: { participants: true },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
  });
  const others = conversations.map((c) => c.participants.find((p) => !(p.userType === me.type && p.userId === me.id))).filter(Boolean);
  const [names, unread] = await Promise.all([namesFor(others), unreadByConversation(me, conversations.map((c) => c.id))]);

  return conversations.map((c) => {
    const other = c.participants.find((p) => !(p.userType === me.type && p.userId === me.id));
    return {
      id: c.id,
      with: names.get(`${other?.userType}:${other?.userId}`) || { type: other?.userType, id: other?.userId, name: "Unknown", subtitle: "" },
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt,
      unread: unread.get(c.id) || 0,
    };
  });
}

async function unreadTotal(me) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*) AS unread
    FROM chat_messages m
    JOIN chat_participants p ON p.conversationId = m.conversationId AND p.userType = ${me.type} AND p.userId = ${me.id}
    WHERE m.id > p.lastReadMessageId AND NOT (m.senderType = ${me.type} AND m.senderId = ${me.id})`;
  return Number(rows?.[0]?.unread || 0);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function requireParticipation(me, conversationId) {
  const participant = await prisma.chatParticipant.findFirst({
    where: { conversationId, userType: me.type, userId: me.id, conversation: { schoolId: me.schoolId } },
    include: { conversation: { include: { participants: true } } },
  });
  if (!participant) throw new AppError("Conversation not found", 404);
  return participant;
}

async function presentMessage(m, viewer) {
  return {
    id: m.id,
    body: m.body,
    sentAt: m.sentAt,
    mine: viewer ? m.senderType === viewer.type && m.senderId === viewer.id : undefined,
    senderType: m.senderType,
    senderId: m.senderId,
    attachment: m.attachmentKey ? { name: m.attachmentName, mime: m.attachmentMime, url: await r2.getPresignedUrl(m.attachmentKey) } : null,
  };
}

/** Messages oldest-first. `afterId` is what a poll asks for; `beforeId` loads older history. */
async function listMessages(me, conversationId, { afterId, beforeId, limit = PAGE_SIZE } = {}) {
  const participant = await requireParticipation(me, conversationId);
  const take = Math.min(Math.max(Number(limit) || PAGE_SIZE, 1), 100);
  const where = { conversationId, ...(afterId ? { id: { gt: Number(afterId) } } : {}), ...(beforeId ? { id: { lt: Number(beforeId) } } : {}) };
  const rows = afterId
    ? await prisma.chatMessage.findMany({ where, orderBy: { id: "asc" }, take: 200 })
    : (await prisma.chatMessage.findMany({ where, orderBy: { id: "desc" }, take })).reverse();

  const other = participant.conversation.participants.find((p) => !(p.userType === me.type && p.userId === me.id));
  const names = await namesFor(other ? [other] : []);
  return {
    with: names.get(`${other?.userType}:${other?.userId}`) || null,
    messages: await Promise.all(rows.map((m) => presentMessage(m, me))),
    hasMore: !afterId && rows.length === take,
  };
}

async function markRead(me, conversationId) {
  const participant = await requireParticipation(me, conversationId);
  const last = await prisma.chatMessage.findFirst({ where: { conversationId }, orderBy: { id: "desc" }, select: { id: true } });
  if (last && last.id > participant.lastReadMessageId) {
    await prisma.chatParticipant.update({ where: { id: participant.id }, data: { lastReadMessageId: last.id } });
  }
  return { read: true };
}

const safeFileName = (name) => String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);

async function sendMessage(me, conversationId, { body, file } = {}) {
  const text = String(body ?? "").trim();
  if (!text && !file) throw new AppError("Write a message or attach a file.", 400);
  if (text.length > MAX_BODY) throw new AppError(`Messages can be at most ${MAX_BODY} characters.`, 400);

  const participant = await requireParticipation(me, conversationId);
  const school = await loadSchool(me.schoolId);
  const other = participant.conversation.participants.find((p) => !(p.userType === me.type && p.userId === me.id));
  const [self, target] = await Promise.all([loadPerson(me, me.schoolId), loadPerson({ type: other.userType, id: other.userId }, me.schoolId)]);
  const verdict = await canChat(self, target, school);
  if (!verdict.ok) throw new AppError(verdict.reason, 403);
  checkRate(me);

  let attachment = {};
  if (file) {
    const key = `chat/${me.schoolId}/${conversationId}/${crypto.randomBytes(8).toString("hex")}-${safeFileName(file.originalname)}`;
    await r2.uploadObject({ buffer: file.buffer, key, contentType: file.mimetype });
    attachment = { attachmentKey: key, attachmentName: String(file.originalname || "file").slice(0, 255), attachmentMime: file.mimetype };
  }

  const message = await prisma.chatMessage.create({ data: { conversationId, senderType: me.type, senderId: me.id, body: text || null, ...attachment } });
  const preview = text ? text.slice(0, 140) : `Attachment: ${attachment.attachmentName}`.slice(0, 140);
  await prisma.chatConversation.update({ where: { id: conversationId }, data: { lastMessageAt: message.sentAt, lastMessagePreview: preview } });
  await prisma.chatParticipant.update({ where: { id: participant.id }, data: { lastReadMessageId: message.id } });
  return presentMessage(message, me);
}

// ---------------------------------------------------------------------------
// Admin: read-only oversight of staff-student chats, and the school switch
// ---------------------------------------------------------------------------

/** `campusWhere` is the admin's campus scope on ChatConversation.campusId ({} when unrestricted). */
async function adminListConversations(schoolId, campusWhere = {}, { page = 1, limit = 30 } = {}) {
  const where = { schoolId, kind: "STAFF_STUDENT", lastMessageAt: { not: null }, ...campusWhere };
  const [rows, total] = await Promise.all([
    prisma.chatConversation.findMany({ where, include: { participants: true }, orderBy: { lastMessageAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.chatConversation.count({ where }),
  ]);
  const names = await namesFor(rows.flatMap((c) => c.participants));
  return {
    total,
    page,
    conversations: rows.map((c) => ({
      id: c.id,
      people: c.participants.map((p) => names.get(`${p.userType}:${p.userId}`) || { type: p.userType, id: p.userId, name: "Unknown", subtitle: "" }),
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt,
    })),
  };
}

async function adminListMessages(schoolId, conversationId, campusWhere = {}, { beforeId, limit = 100 } = {}) {
  const conversation = await prisma.chatConversation.findFirst({ where: { id: conversationId, schoolId, kind: "STAFF_STUDENT", ...campusWhere }, include: { participants: true } });
  if (!conversation) throw new AppError("Conversation not found", 404);
  const rows = (await prisma.chatMessage.findMany({ where: { conversationId, ...(beforeId ? { id: { lt: Number(beforeId) } } : {}) }, orderBy: { id: "desc" }, take: Math.min(Number(limit) || 100, 200) })).reverse();
  const names = await namesFor(conversation.participants);
  const messages = await Promise.all(
    rows.map(async (m) => ({ ...(await presentMessage(m, null)), senderName: names.get(`${m.senderType}:${m.senderId}`)?.name || "Unknown" })),
  );
  return { people: conversation.participants.map((p) => names.get(`${p.userType}:${p.userId}`)).filter(Boolean), messages };
}

async function getSettings(schoolId) {
  const school = await loadSchool(schoolId);
  return { chatStudentsEnabled: school.chatStudentsEnabled };
}

async function setStudentChatEnabled(schoolId, enabled) {
  await prisma.school.update({ where: { id: schoolId }, data: { chatStudentsEnabled: Boolean(enabled) } });
  return { chatStudentsEnabled: Boolean(enabled) };
}

module.exports = {
  STAFF,
  STUDENT,
  MAX_BODY,
  pairKeyOf,
  canChat,
  listContacts,
  openConversation,
  listConversations,
  unreadTotal,
  listMessages,
  markRead,
  sendMessage,
  adminListConversations,
  adminListMessages,
  getSettings,
  setStudentChatEnabled,
  _resetRateLimit: () => sentRecently.clear(),
};
