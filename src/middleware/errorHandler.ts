import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, Errors } from '../errors';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.notFound());

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    appError = Errors.conflict();
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    appError = Errors.validation({ _: 'One of the options you picked is not valid.' });
  } else if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    appError = Errors.validation({ _: 'We could not read that request.' });
  } else {
    console.error(`[${req.id}]`, err);
    res.status(500).json({
      error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Try again.', requestId: req.id },
    });
    return;
  }

  res.status(appError.status).json({
    error: { code: appError.code, message: appError.message, details: appError.details, requestId: req.id },
  });
};
