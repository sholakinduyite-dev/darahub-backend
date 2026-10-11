import crypto from 'crypto';
import type { User } from '@prisma/client';
import { prisma } from '../db';

// Accepts 08012345678, +2348012345678 or 2348012345678 and returns +2348012345678. Returns null if it is not a Nigerian mobile number.
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const match = digits.match(/^(?:\+?234|0)([789][01]\d{8})$/);
  return match ? `+234${match[1]}` : null;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    let code = 'DH';
    for (let j = 0; j < 6; j++) code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    const taken = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!taken) return code;
  }
  throw new Error('Could not create a referral code');
}

export function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    referralCode: user.referralCode,
    pointsBalance: user.pointsBalance,
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    createdAt: user.createdAt,
  };
}

export const isVerified = (user: User) => Boolean(user.emailVerifiedAt || user.phoneVerifiedAt);
