// src/controllers/teacher/AttendanceController.ts
import { Response, NextFunction } from "express";
import { TeacherRequest } from "../../middleware/teacherMiddleware";
import { AttendanceService } from "../../Services/teacher/AttendanceService";

const STATUSES = ["present", "absent", "late"];

export class AttendanceController {
    private service = new AttendanceService();

    markAttendance = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { classId, groupId, date, records } = req.body;
            if (!classId || !date || !Array.isArray(records)) {
                return res.status(400).json({ success: false, message: "classId, date and records[] are required" });
            }
            if (records.some((r: any) => !STATUSES.includes(r.status))) {
                return res.status(400).json({ success: false, message: "Each record's status must be present, absent, or late" });
            }

            const result = await this.service.markAttendance({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                groupId: groupId != null && groupId !== "" ? Number(groupId) : null,
                date,
                records,
            });

            return res.json({ success: true, data: result });
        } catch (err) {
            if (err instanceof Error && err.message === "You are not assigned to this class") {
                return res.status(403).json({ success: false, message: err.message });
            }
            if (err instanceof Error && err.message === "That group does not belong to the selected class") {
                return res.status(400).json({ success: false, message: err.message });
            }
            next(err);
        }
    };

    getAttendance = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { classId, groupId, date } = req.query;
            if (!classId || !date) {
                return res.status(400).json({ success: false, message: "classId and date are required" });
            }

            const result = await this.service.getAttendance({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                groupId: groupId ? Number(groupId) : null,
                date: String(date),
            });

            return res.json({ success: true, data: result });
        } catch (err) {
            if (err instanceof Error && err.message === "You are not assigned to this class") {
                return res.status(403).json({ success: false, message: err.message });
            }
            if (err instanceof Error && err.message === "That group does not belong to the selected class") {
                return res.status(400).json({ success: false, message: err.message });
            }
            next(err);
        }
    };

    getAttendanceReport = async (req: TeacherRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.staffId || !req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { classId, groupId, startDate, endDate } = req.query;
            if (!classId || !startDate || !endDate) {
                return res.status(400).json({ success: false, message: "classId, startDate and endDate are required" });
            }

            const result = await this.service.getAttendanceReport({
                staffId: req.staffId,
                schoolId: req.schoolId,
                classId: Number(classId),
                groupId: groupId ? Number(groupId) : null,
                startDate: String(startDate),
                endDate: String(endDate),
            });

            return res.json({ success: true, data: result });
        } catch (err) {
            if (err instanceof Error && err.message === "You are not assigned to this class") {
                return res.status(403).json({ success: false, message: err.message });
            }
            if (err instanceof Error && err.message === "That group does not belong to the selected class") {
                return res.status(400).json({ success: false, message: err.message });
            }
            next(err);
        }
    };
}
