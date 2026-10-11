import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { Errors } from '../errors';

export function hmac(value: string): string {
  return crypto.createHmac('sha256', config.hashSecret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function signAccessToken(user: { id: string; role: Role }): string {
  return jwt.sign({ role: user.role }, config.jwtAccessSecret, { subject: user.id, expiresIn: config.accessTokenSeconds });
}

// Short-lived tokens for the middle of a flow (Google setup, password reset). They only work for their own purpose.
export function signPurposeToken(purpose: string, payload: Record<string, unknown>, seconds: number): string {
  return jwt.sign({ ...payload, purpose }, config.hashSecret, { expiresIn: seconds });
}

export function verifyPurposeToken<T extends Record<string, unknown>>(token: string, purpose: string): T {
  try {
    const payload = jwt.verify(token, config.hashSecret) as jwt.JwtPayload;
    if (payload.purpose !== purpose) throw new Error('wrong purpose');
    return payload as unknown as T;
  } catch {
    throw Errors.sessionExpired();
  }
}

// Creates a login session and returns tokens. The refresh token is random and only a fingerprint of it is stored.
export async function issueSession(user: { id: string; role: Role }, device?: string) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hmac(refreshToken),
      device,
      expiresAt: new Date(Date.now() + config.refreshTokenDays * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken: signAccessToken(user), refreshToken, expiresIn: config.accessTokenSeconds };
}
