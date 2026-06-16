import { Request, Response, NextFunction } from "express";
import { StudentAuthService } from "../../Services/auth/StudentAuthService";

export class StudentAuthController {
    private studentAuthService = new StudentAuthService();

    login = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { registrationNumber } = req.body;

            // Validate input before hitting the database
            if (!registrationNumber) {
                throw new Error("registrationNumber is required");
            }

            const result = await this.studentAuthService.login(registrationNumber);

            res.status(200).json({
                success: true,
                message: "Login successful",
                data: result
            });
        } catch (err) {
            next(err); // passes to global error handler
        }
    };
}
