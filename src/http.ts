import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { Errors } from './errors';

// Lets route handlers be async without try/catch: errors go to the error handler.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

// Validates input and turns problems into the standard VALIDATION_ERROR with one message per field.
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw Errors.validation(fields);
  }
  return result.data;
}

export function userId(req: Request): string {
  if (!req.user) throw Errors.unauthorized();
  return req.user.id;
}
