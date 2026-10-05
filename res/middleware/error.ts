import { Request, Response, NextFunction } from "express";
import { AppError } from "../util/AppError";
import logger from "../config/logger";

export const errorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) return next(err);

  // log real error
  logger.error(`${req.method} ${req.url} - ${err?.stack || err?.message || err}`);
  console.error(err);

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const message = isAppError ? err.message : (err?.message || "Internal Server Error");

  // `code` and `details` are forwarded only for AppError. Clients branch on
  // the code (a duplicate scheme of work offers "Replace" rather than just
  // showing the message), but an unhandled Prisma failure also carries a
  // `code` like P2002, and that is an internal detail a client must not see.
  return res.status(statusCode).json({
    success: false,
    message,
    ...(isAppError && (err as any).code ? { code: (err as any).code } : {}),
    ...(isAppError && (err as any).details ? { details: (err as any).details } : {}),
  });
};
