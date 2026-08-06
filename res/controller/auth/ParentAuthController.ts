import { Response, NextFunction } from "express";
import { Request } from "express";
import { ParentAuthService } from "../../Services/auth/ParentAuthService";
import { ParentRequest } from "../../middleware/parentMiddleware";

export class ParentAuthController {
    private service = new ParentAuthService();

    signup = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { email, password, name, phone } = req.body;
            if (!email || !password || !name) {
                return res.status(400).json({ success: false, message: "email, password and name are required" });
            }

            const result = await this.service.signup({ email, password, name, phone });
            res.status(201).json({ success: true, message: "Account created", data: result });
        } catch (err) {
            next(err);
        }
    };

    login = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ success: false, message: "email and password are required" });
            }

            const result = await this.service.login({ email, password }, req);
            res.status(200).json({ success: true, message: "Login successful", data: result });
        } catch (err) {
            next(err);
        }
    };

    linkChild = async (req: ParentRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.parentId) return res.status(401).json({ success: false, message: "Unauthorized" });

            const { admissionNo, contact } = req.body;
            if (!admissionNo || !contact) {
                return res.status(400).json({ success: false, message: "admissionNo and contact are required" });
            }

            const result = await this.service.linkChild({ parentId: req.parentId, admissionNo, contact });
            res.status(200).json({ success: true, message: "Child linked successfully", data: result });
        } catch (err) {
            next(err);
        }
    };
}
