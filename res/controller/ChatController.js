const chat = require("../Services/ChatService");
const campusScope = require("../util/campusScope");

/**
 * The chat API, mounted twice (teacher and student routes) because each role's auth middleware
 * exposes the caller under a different request property; plus the admin's read-only view.
 * All rules live in ChatService.
 */
const identity = {
  teacher: (req) => ({ type: chat.STAFF, id: req.staffId, schoolId: req.schoolId }),
  student: (req) => ({ type: chat.STUDENT, id: req.studentId, schoolId: req.schoolId }),
};

const buildHandlers = (who) => ({
  contacts: async (req, res, next) => {
    try {
      res.json({ success: true, data: await chat.listContacts(who(req), req.query.search) });
    } catch (err) {
      next(err);
    }
  },

  conversations: async (req, res, next) => {
    try {
      res.json({ success: true, data: await chat.listConversations(who(req)) });
    } catch (err) {
      next(err);
    }
  },

  unread: async (req, res, next) => {
    try {
      res.json({ success: true, data: { unread: await chat.unreadTotal(who(req)) } });
    } catch (err) {
      next(err);
    }
  },

  open: async (req, res, next) => {
    try {
      const type = String(req.body.type || "").toUpperCase();
      const id = Number(req.body.id);
      if (![chat.STAFF, chat.STUDENT].includes(type) || !Number.isInteger(id)) {
        return res.status(400).json({ success: false, message: "type (STAFF or STUDENT) and id are required" });
      }
      res.json({ success: true, data: await chat.openConversation(who(req), { type, id }) });
    } catch (err) {
      next(err);
    }
  },

  messages: async (req, res, next) => {
    try {
      const { afterId, beforeId, limit } = req.query;
      res.json({ success: true, data: await chat.listMessages(who(req), Number(req.params.id), { afterId, beforeId, limit }) });
    } catch (err) {
      next(err);
    }
  },

  send: async (req, res, next) => {
    try {
      const message = await chat.sendMessage(who(req), Number(req.params.id), { body: req.body.body, file: req.file });
      res.status(201).json({ success: true, data: message });
    } catch (err) {
      next(err);
    }
  },

  read: async (req, res, next) => {
    try {
      res.json({ success: true, data: await chat.markRead(who(req), Number(req.params.id)) });
    } catch (err) {
      next(err);
    }
  },
});

const admin = {
  conversations: async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      res.json({ success: true, data: await chat.adminListConversations(req.schoolId, campusScope.classWhere(req), { page }) });
    } catch (err) {
      next(err);
    }
  },

  messages: async (req, res, next) => {
    try {
      res.json({ success: true, data: await chat.adminListMessages(req.schoolId, Number(req.params.id), campusScope.classWhere(req), { beforeId: req.query.beforeId }) });
    } catch (err) {
      next(err);
    }
  },

  getSettings: async (req, res, next) => {
    try {
      res.json({ success: true, data: await chat.getSettings(req.schoolId) });
    } catch (err) {
      next(err);
    }
  },

  setSettings: async (req, res, next) => {
    try {
      // The switch is the school's, not a campus's: head admins only.
      if (campusScope.isRestricted(req)) {
        return res.status(403).json({ success: false, message: "Only the head admin can change this setting" });
      }
      if (typeof req.body.chatStudentsEnabled !== "boolean") {
        return res.status(400).json({ success: false, message: "chatStudentsEnabled (true or false) is required" });
      }
      res.json({ success: true, data: await chat.setStudentChatEnabled(req.schoolId, req.body.chatStudentsEnabled) });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = { teacher: buildHandlers(identity.teacher), student: buildHandlers(identity.student), admin };
