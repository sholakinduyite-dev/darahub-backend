import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { config } from '../config';
import { Errors } from '../errors';

function readToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function decode(token: string): { id: string; role: Role } {
  const payload = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
  return { id: String(payload.sub), role: payload.role as Role };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readToken(req.headers.authorization);
  if (!token) return next(Errors.unauthorized());
  try {
    req.user = decode(token);
    next();
  } catch {
    next(Errors.sessionExpired());
  }
};

// For public pages that show extra info when the person is signed in (for example "is this a favorite").
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readToken(req.headers.authorization);
  if (token) {
    try {
      req.user = decode(token);
    } catch {
      // ignore: treat as signed out
    }
  }
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(Errors.unauthorized());
    if (!roles.includes(req.user.role)) return next(Errors.forbidden());
    next();
  };
