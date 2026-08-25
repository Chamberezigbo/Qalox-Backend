import { Response, NextFunction, Request } from "express";
import { AdminParentService } from "../../Services/admin/AdminParentService";

interface AdminRequest extends Request {
    schoolId?: number;
}

export class AdminParentController {
    private service = new AdminParentService();

    create = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { name, email, phone, registrationNumbers } = req.body;
            const data = await this.service.createOrLinkParent({
                schoolId: req.schoolId,
                name,
                email,
                phone,
                registrationNumbers,
            });

            return res.status(201).json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    update = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { name, email, phone } = req.body;
            const data = await this.service.updateParent(req.schoolId, Number(req.params.id), { name, email, phone });

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    linkChildren = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { registrationNumbers } = req.body;
            const data = await this.service.linkChildren(req.schoolId, Number(req.params.id), registrationNumbers);

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    unlinkChild = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const data = await this.service.unlinkChild(req.schoolId, Number(req.params.id), Number(req.params.studentId));

            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    list = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const data = await this.service.list(req.schoolId);
            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };

    resetPassword = async (req: AdminRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.schoolId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const data = await this.service.resetPassword(req.schoolId, Number(req.params.id));
            return res.json({ success: true, data });
        } catch (err) {
            next(err);
        }
    };
}
