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

  return res.status(statusCode).json({
    success: false,
    message
  });
};
