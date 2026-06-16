import { Request, Response, NextFunction } from "express";
import { TeacherAuthService } from "../../Services/auth/TeacherAuthService";

export class TeacherAuthController {
    private teacherAuthService = new TeacherAuthService();

    login = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { registrationNumber } = req.body;

            if (!registrationNumber) {
                throw new Error("registrationNumber is required");
            }

            const result = await this.teacherAuthService.login({ registrationNumber });

            res.status(200).json({
                success: true,
                message: "Login successful",
                data: result
            });
        } catch (err) {
            next(err);
        }
    };
}
