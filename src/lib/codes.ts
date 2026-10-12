import crypto from 'crypto';
import type { CodePurpose } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { Errors } from '../errors';
import { getSetting } from '../services/settings';
import { sendCode } from './messenger';
import { hmac, safeEqual } from './tokens';

// "identifier" is what the app uses to find the code again when verifying.
// Verification delivery is email-only; "deliverTo" is the account email address.
export async function createCode(opts: {
  userId: string;
  identifier: string;
  deliverTo: string;
  channel: 'EMAIL';
  purpose: CodePurpose;
}) {
  const waitSeconds = await getSetting('resend_wait_seconds', 60);
  const last = await prisma.verificationCode.findFirst({
    where: { target: opts.identifier, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (last) {
    const elapsed = (Date.now() - last.createdAt.getTime()) / 1000;
    if (elapsed < waitSeconds) throw Errors.rateLimited(Math.ceil(waitSeconds - elapsed));
  }

  await prisma.verificationCode.updateMany({
    where: { target: opts.identifier, purpose: opts.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const minutes = await getSetting('verification_code_minutes', 10);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.verificationCode.create({
    data: {
      userId: opts.userId,
      target: opts.identifier,
      channel: opts.channel,
      purpose: opts.purpose,
      codeHash: hmac(`${opts.identifier}:${opts.purpose}:${code}`),
      expiresAt: new Date(Date.now() + minutes * 60 * 1000),
    },
  });

  await sendCode({ channel: opts.channel, to: opts.deliverTo, code, minutes });

  return {
    expiresInSeconds: minutes * 60,
    resendInSeconds: waitSeconds,
    ...(config.devShowCodes ? { devCode: code } : {}),
  };
}

export async function verifyCode(identifier: string, purpose: CodePurpose, code: string) {
  const record = await prisma.verificationCode.findFirst({
    where: { target: identifier, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record || record.expiresAt.getTime() < Date.now()) throw Errors.codeExpired();

  const maxAttempts = await getSetting('verification_max_attempts', 5);
  if (record.attempts >= maxAttempts) throw Errors.tooManyAttempts();

  if (!safeEqual(record.codeHash, hmac(`${identifier}:${purpose}:${code}`))) {
    const attempts = record.attempts + 1;
    await prisma.verificationCode.update({ where: { id: record.id }, data: { attempts } });
    if (attempts >= maxAttempts) throw Errors.tooManyAttempts();
    throw Errors.codeInvalid(maxAttempts - attempts);
  }

  await prisma.verificationCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  return record;
}
