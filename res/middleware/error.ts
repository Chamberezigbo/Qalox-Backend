import { Request, Response, NextFunction } from "express";
import { AppError } from "../util/AppError";
import logger from "../config/logger";
import { captureError } from "../util/errorTracker";

export const errorMiddleware = async (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) return next(err);

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  let message = isAppError ? err.message : (err?.message || "Internal Server Error");

  // One structured line (searchable by requestId, route, user, school), not a stack in a sentence.
  logger.error(`${req.method} ${(req.originalUrl || req.url || "").split("?")[0]} - ${err?.message || err}`, {
    statusCode,
    stack: err?.stack,
    schoolId: (req as any).schoolId,
  });

  // Server errors are also saved to the database, which outlives Railway's log window. The
  // reference lets a user report the exact failure: "Ref: 1a2b3c4d" finds it in one query.
  let reference: string | undefined;
  if (statusCode >= 500) {
    const requestId = await captureError(err, { req, statusCode });
    if (requestId) {
      reference = requestId.slice(0, 8);
      message = `${message} (Ref: ${reference})`;
    }
  }

  // `code` and `details` are forwarded only for AppError. Clients branch on
  // the code (a duplicate scheme of work offers "Replace" rather than just
  // showing the message), but an unhandled Prisma failure also carries a
  // `code` like P2002, and that is an internal detail a client must not see.
  return res.status(statusCode).json({
    success: false,
    message,
    ...(reference ? { requestId: (req as any).requestId } : {}),
    ...(isAppError && (err as any).code ? { code: (err as any).code } : {}),
    ...(isAppError && (err as any).details ? { details: (err as any).details } : {}),
  });
};
