// Who may chat with whom, and how threads and messages behave. Prisma and R2 are mocked.
/* eslint-disable @typescript-eslint/no-var-requires */
const mockPrisma: any = {
  school: { findUnique: jest.fn(), update: jest.fn() },
  staff: { findFirst: jest.fn(), findMany: jest.fn() },
  student: { findFirst: jest.fn(), findMany: jest.fn() },
  class: { findFirst: jest.fn(), findMany: jest.fn() },
  teacherAssignment: { findFirst: jest.fn(), findMany: jest.fn() },
  chatConversation: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  chatParticipant: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  chatMessage: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  $queryRaw: jest.fn(),
};
const mockR2: any = { uploadObject: jest.fn(), getPresignedUrl: jest.fn() };
jest.mock("../util/prisma", () => mockPrisma);
jest.mock("../Services/R2Service", () => mockR2);

const chat = require("../Services/ChatService");

const teacher = { type: "STAFF", id: 3, schoolId: 7 };
const colleague = { type: "STAFF", id: 4, schoolId: 7 };
const pupil = { type: "STUDENT", id: 40, schoolId: 7 };

const staffRow = (id: number) => ({ id, name: `Staff ${id}`, duty: "Teacher", campusId: null });
const studentRow = (id: number, classId = 11) => ({ id, name: "Ada", surname: "Obi", classId, campusId: 2, class: { name: "SS 1", campusId: 2 } });

/** Wires the lookups for a school, who is a teacher, which students are active and which classes the teacher teaches. */
function world({ chatStudentsEnabled = true, teaches = [11], activeStudents = [40] }: { chatStudentsEnabled?: boolean; teaches?: number[]; activeStudents?: number[] } = {}) {
  mockPrisma.school.findUnique.mockResolvedValue({ id: 7, chatStudentsEnabled });
  mockPrisma.staff.findFirst.mockImplementation(async ({ where }: any) => staffRow(where.id));
  mockPrisma.student.findFirst.mockImplementation(async ({ where }: any) => (activeStudents.includes(where.id) ? studentRow(where.id) : null));
  mockPrisma.class.findFirst.mockResolvedValue(null);
  mockPrisma.teacherAssignment.findFirst.mockImplementation(async ({ where }: any) => (teaches.includes(where.classId) ? { id: 1 } : null));
}

beforeEach(() => {
  jest.resetAllMocks();
  chat._resetRateLimit();
  mockR2.getPresignedUrl.mockResolvedValue("https://signed");
});

describe("who may chat (openConversation)", () => {
  beforeEach(() => {
    mockPrisma.chatConversation.findUnique.mockResolvedValue(null);
    mockPrisma.chatConversation.create.mockResolvedValue({ id: 99 });
  });

  it("lets two staff members chat", async () => {
    world();
    const result = await chat.openConversation(teacher, colleague);
    expect(result.id).toBe(99);
    expect(mockPrisma.chatConversation.create.mock.calls[0][0].data.kind).toBe("STAFF_STAFF");
  });

  it("lets a teacher chat with a student they teach, tagged with the student's campus", async () => {
    world();
    await chat.openConversation(teacher, pupil);
    const data = mockPrisma.chatConversation.create.mock.calls[0][0].data;
    expect(data.kind).toBe("STAFF_STUDENT");
    expect(data.campusId).toBe(2);
  });

  it("refuses a student the teacher does not teach", async () => {
    world({ teaches: [12] });
    await expect(chat.openConversation(teacher, pupil)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it("refuses a withdrawn student", async () => {
    world({ activeStudents: [] });
    await expect(chat.openConversation(teacher, pupil)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses every staff-student chat when the school has switched it off, but staff can still chat", async () => {
    world({ chatStudentsEnabled: false });
    await expect(chat.openConversation(teacher, pupil)).rejects.toMatchObject({ statusCode: 403 });
    await expect(chat.openConversation(pupil, teacher)).rejects.toMatchObject({ statusCode: 403 });
    await expect(chat.openConversation(teacher, colleague)).resolves.toBeTruthy();
  });

  it("never lets two students chat, or someone chat with themselves", async () => {
    world({ activeStudents: [40, 41] });
    await expect(chat.openConversation(pupil, { type: "STUDENT", id: 41 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(chat.openConversation(teacher, teacher)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lets a student open a chat with their own teacher", async () => {
    world();
    await expect(chat.openConversation(pupil, teacher)).resolves.toBeTruthy();
  });

  it("gives both people the same thread, whoever opens it", () => {
    expect(chat.pairKeyOf(teacher, pupil)).toBe(chat.pairKeyOf(pupil, teacher));
  });

  it("reuses the thread that already exists", async () => {
    world();
    mockPrisma.chatConversation.findUnique.mockResolvedValue({ id: 5 });
    const result = await chat.openConversation(teacher, colleague);
    expect(result.id).toBe(5);
    expect(mockPrisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it("falls back to the winner when two people open it at the same moment", async () => {
    world();
    mockPrisma.chatConversation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 8 });
    mockPrisma.chatConversation.create.mockRejectedValue({ code: "P2002" });
    expect((await chat.openConversation(teacher, colleague)).id).toBe(8);
  });
});

describe("sending", () => {
  const thread = (me: any, other: any) => ({
    id: 1,
    lastReadMessageId: 0,
    conversation: { participants: [{ userType: me.type, userId: me.id }, { userType: other.type, userId: other.id }] },
  });

  beforeEach(() => {
    mockPrisma.chatMessage.create.mockResolvedValue({ id: 10, body: "hi", sentAt: new Date(), senderType: "STAFF", senderId: 3, attachmentKey: null });
    mockPrisma.chatConversation.update.mockResolvedValue({});
    mockPrisma.chatParticipant.update.mockResolvedValue({});
  });

  it("stores a message, updates the thread preview and marks it read for the sender", async () => {
    world();
    mockPrisma.chatParticipant.findFirst.mockResolvedValue(thread(teacher, colleague));
    const sent = await chat.sendMessage(teacher, 1, { body: "  hello  " });
    expect(mockPrisma.chatMessage.create.mock.calls[0][0].data.body).toBe("hello");
    expect(mockPrisma.chatConversation.update.mock.calls[0][0].data.lastMessagePreview).toBe("hello");
    expect(mockPrisma.chatParticipant.update.mock.calls[0][0].data.lastReadMessageId).toBe(10);
    expect(sent.mine).toBe(true);
  });

  it("is refused when the chat rule no longer holds (school switched student chat off)", async () => {
    world({ chatStudentsEnabled: false });
    mockPrisma.chatParticipant.findFirst.mockResolvedValue(thread(teacher, pupil));
    await expect(chat.sendMessage(teacher, 1, { body: "hi" })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("treats someone else's thread as not found", async () => {
    world();
    mockPrisma.chatParticipant.findFirst.mockResolvedValue(null);
    await expect(chat.sendMessage(teacher, 1, { body: "hi" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an empty message and an over-long one", async () => {
    world();
    await expect(chat.sendMessage(teacher, 1, { body: "   " })).rejects.toMatchObject({ statusCode: 400 });
    await expect(chat.sendMessage(teacher, 1, { body: "x".repeat(chat.MAX_BODY + 1) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("uploads an attachment to R2 and keeps only its key", async () => {
    world();
    mockPrisma.chatParticipant.findFirst.mockResolvedValue(thread(teacher, colleague));
    await chat.sendMessage(teacher, 1, { file: { originalname: "my work.pdf", buffer: Buffer.from("x"), mimetype: "application/pdf" } });
    const key = mockR2.uploadObject.mock.calls[0][0].key;
    expect(key).toMatch(/^chat\/7\/1\/[0-9a-f]+-my_work\.pdf$/);
    expect(mockPrisma.chatMessage.create.mock.calls[0][0].data.attachmentKey).toBe(key);
  });

  it("slows a sender who sends too many messages a minute", async () => {
    world();
    mockPrisma.chatParticipant.findFirst.mockResolvedValue(thread(teacher, colleague));
    for (let i = 0; i < 30; i++) await chat.sendMessage(teacher, 1, { body: `m${i}` });
    await expect(chat.sendMessage(teacher, 1, { body: "one more" })).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("reading", () => {
  it("lists the newest page oldest-first, flagging which are mine", async () => {
    mockPrisma.chatParticipant.findFirst.mockResolvedValue({ id: 1, conversation: { participants: [{ userType: "STAFF", userId: 3 }, { userType: "STAFF", userId: 4 }] } });
    mockPrisma.staff.findMany.mockResolvedValue([{ id: 4, name: "Staff 4", duty: "Teacher" }]);
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      { id: 2, senderType: "STAFF", senderId: 4, body: "b", sentAt: new Date(), attachmentKey: null },
      { id: 1, senderType: "STAFF", senderId: 3, body: "a", sentAt: new Date(), attachmentKey: null },
    ]);
    const out = await chat.listMessages(teacher, 1);
    expect(out.messages.map((m: any) => m.id)).toEqual([1, 2]);
    expect(out.messages.map((m: any) => m.mine)).toEqual([true, false]);
    expect(out.with.name).toBe("Staff 4");
  });

  it("only asks for messages newer than the last one seen when polling", async () => {
    mockPrisma.chatParticipant.findFirst.mockResolvedValue({ id: 1, conversation: { participants: [] } });
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);
    await chat.listMessages(teacher, 1, { afterId: "5" });
    expect(mockPrisma.chatMessage.findMany.mock.calls[0][0].where.id).toEqual({ gt: 5 });
  });

  it("marks everything up to the latest message as read", async () => {
    mockPrisma.chatParticipant.findFirst.mockResolvedValue({ id: 9, lastReadMessageId: 2, conversation: { participants: [] } });
    mockPrisma.chatMessage.findFirst.mockResolvedValue({ id: 6 });
    await chat.markRead(teacher, 1);
    expect(mockPrisma.chatParticipant.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { lastReadMessageId: 6 } });
  });

  it("totals unread messages", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ unread: BigInt(4) }]);
    expect(await chat.unreadTotal(teacher)).toBe(4);
  });
});

describe("contacts", () => {
  it("shows a teacher colleagues and only the students of classes they teach", async () => {
    world();
    mockPrisma.staff.findMany.mockResolvedValue([{ id: 4, name: "Staff 4", duty: "Bursar" }]);
    mockPrisma.teacherAssignment.findMany.mockResolvedValue([{ classId: 11 }]);
    mockPrisma.class.findMany.mockResolvedValue([{ id: 12 }]);
    mockPrisma.student.findMany.mockResolvedValue([{ id: 40, name: "Ada", surname: "Obi", class: { name: "SS 1" } }]);
    const out = await chat.listContacts(teacher);
    expect(out.colleagues).toHaveLength(1);
    expect(out.students[0].name).toBe("Ada Obi");
    expect(mockPrisma.student.findMany.mock.calls[0][0].where.classId).toEqual({ in: [11, 12] });
    expect(mockPrisma.student.findMany.mock.calls[0][0].where.status).toBe("active");
  });

  it("shows no students at all when student chat is off", async () => {
    world({ chatStudentsEnabled: false });
    mockPrisma.staff.findMany.mockResolvedValue([]);
    expect((await chat.listContacts(teacher)).students).toEqual([]);
    expect(mockPrisma.student.findMany).not.toHaveBeenCalled();
  });

  it("shows a student only the teachers of their own class", async () => {
    world();
    mockPrisma.teacherAssignment.findMany.mockResolvedValue([{ staffId: 3 }, { staffId: 3 }]);
    mockPrisma.class.findFirst.mockResolvedValue({ staffId: 5 });
    mockPrisma.staff.findMany.mockResolvedValue([{ id: 3, name: "Staff 3", duty: "Teacher" }, { id: 5, name: "Staff 5", duty: "Teacher" }]);
    const out = await chat.listContacts(pupil);
    expect(mockPrisma.staff.findMany.mock.calls[0][0].where.id).toEqual({ in: [3, 5] });
    expect(out.teachers).toHaveLength(2);
    expect(out.colleagues).toEqual([]);
  });
});

describe("admin oversight", () => {
  it("only lists staff-student chats, inside the admin's campuses", async () => {
    mockPrisma.chatConversation.findMany.mockResolvedValue([]);
    mockPrisma.chatConversation.count.mockResolvedValue(0);
    await chat.adminListConversations(7, { campusId: { in: [1, 2] } });
    const where = mockPrisma.chatConversation.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ schoolId: 7, kind: "STAFF_STUDENT", campusId: { in: [1, 2] } });
  });

  it("reads another campus's thread as not found", async () => {
    mockPrisma.chatConversation.findFirst.mockResolvedValue(null);
    await expect(chat.adminListMessages(7, 3, { campusId: { in: [1] } })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.chatConversation.findFirst.mock.calls[0][0].where).toMatchObject({ kind: "STAFF_STUDENT", campusId: { in: [1] } });
  });
});

describe("admin switch (controller)", () => {
  const controller = require("../controller/ChatController");
  const run = async (req: any) => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.admin.setSettings({ schoolId: 7, body: {}, ...req }, res, jest.fn());
    return res;
  };

  it("is for the head admin only", async () => {
    const res = await run({ campusIds: [1], body: { chatStudentsEnabled: false } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.school.update).not.toHaveBeenCalled();
  });

  it("switches student chat off for the school", async () => {
    mockPrisma.school.update.mockResolvedValue({});
    await run({ campusIds: null, body: { chatStudentsEnabled: false } });
    expect(mockPrisma.school.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { chatStudentsEnabled: false } });
  });

  it("wants a true or false", async () => {
    const res = await run({ campusIds: null, body: { chatStudentsEnabled: "no" } });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

export {};
