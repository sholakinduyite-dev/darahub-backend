import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import type { CodeChannel, CodePurpose, Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { AppError, Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { requireAuth } from '../middleware/auth';
import { createCode, verifyCode } from '../lib/codes';
import { isVerified, normalizePhone, publicUser, uniqueReferralCode } from '../lib/identity';
import { maskEmail } from '../lib/messenger';
import { hmac, issueSession, signPurposeToken, verifyPurposeToken } from '../lib/tokens';
import { getSetting } from '../services/settings';

export const authRouter = Router();

authRouter.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(Errors.rateLimited()),
  }),
);

// ---------- input rules (messages are the plain words the app shows under each field) ----------
const email = z.string({ required_error: 'Enter your email' }).trim().toLowerCase().email('Enter a valid email, like name@email.com');
const password = z.string({ required_error: 'Enter a password' }).min(8, 'Use at least 8 characters').regex(/\d/, 'Include at least one number');
const phone = z
  .string({ required_error: 'Enter your phone number' })
  .trim()
  .refine((v) => normalizePhone(v) !== null, 'Enter an 11-digit phone number')
  .transform((v) => normalizePhone(v) as string);
const code = z.string({ required_error: 'Enter the 6-digit code' }).trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
const terms = z.literal(true, { errorMap: () => ({ message: 'Please agree to the Terms and Privacy Policy' }) });
const device = z.string().max(100).optional();

const PURPOSES = { signup: 'SIGNUP', google_phone: 'GOOGLE_PHONE', reset: 'RESET_PASSWORD' } as const;
const purposeEnum = z.enum(['signup', 'google_phone', 'reset']);
const purposeName = (p: CodePurpose) => (Object.keys(PURPOSES) as (keyof typeof PURPOSES)[]).find((k) => PURPOSES[k] === p) as string;

function normalizeIdentifier(raw: string): string {
  const v = raw.trim();
  return v.includes('@') ? v.toLowerCase() : normalizePhone(v) ?? v;
}

async function resolveReferral(codeInput?: string): Promise<string | undefined> {
  if (!codeInput) return undefined;
  const referrer = await prisma.user.findUnique({ where: { referralCode: codeInput } });
  if (!referrer) throw Errors.validation({ referralCode: "That referral code isn't valid." });
  return referrer.id;
}

// Sends a code for an existing person. When the person does not exist (or does not need a code) it answers exactly the
// same way without sending anything, so nobody can use this to find out who has an account.
async function sendFor(identifier: string, purpose: CodePurpose, _wanted?: CodeChannel) {
  const user = identifier.includes('@')
    ? await prisma.user.findUnique({ where: { email: identifier } })
    : await prisma.user.findUnique({ where: { phone: identifier } });

  const eligible =
    !!user &&
    (purpose === 'RESET_PASSWORD' || (purpose === 'SIGNUP' && !user.emailVerifiedAt && !user.phoneVerifiedAt) || (purpose === 'GOOGLE_PHONE' && !user.phoneVerifiedAt));

  // SMS delivery is intentionally disabled. All verification and reset codes go to the account email.
  const channel: CodeChannel = 'EMAIL';

  const base = { next: 'verify', purpose: purposeName(purpose), target: identifier, channel };

  if (!user || !eligible) {
    return {
      ...base,
      sentTo: identifier.includes('@') ? maskEmail(identifier) : 'your account email',
      expiresInSeconds: (await getSetting('verification_code_minutes', 10)) * 60,
      resendInSeconds: await getSetting('resend_wait_seconds', 60),
    };
  }

  const deliverTo = user.email as string;
  const sent = await createCode({ userId: user.id, identifier, deliverTo, channel, purpose });
  return { ...base, sentTo: maskEmail(deliverTo), ...sent };
}

// ---------- sign up ----------
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string({ required_error: 'Enter your full name' }).trim().min(2, 'Enter your full name'),
        email,
        phone,
        password,
        referralCode: z.string().trim().toUpperCase().optional(),
        acceptedTerms: terms,
      }),
      req.body,
    );

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing && isVerified(existing)) throw Errors.emailTaken();
    const phoneOwner = await prisma.user.findUnique({ where: { phone: body.phone } });
    if (phoneOwner && phoneOwner.id !== existing?.id) throw Errors.phoneTaken();
    const referredById = await resolveReferral(body.referralCode);

    const passwordHash = await bcrypt.hash(body.password, 12);
    // An earlier sign-up that was never verified is simply overwritten with the new details.
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: { name: body.name, phone: body.phone, passwordHash } })
      : await prisma.user.create({
          data: { name: body.name, email: body.email, phone: body.phone, passwordHash, referralCode: await uniqueReferralCode(), referredById },
        });

    const sent = await createCode({ userId: user.id, identifier: body.email, deliverTo: body.email, channel: 'EMAIL', purpose: 'SIGNUP' });
    res.status(201).json({ next: 'verify', purpose: 'signup', target: body.email, channel: 'EMAIL', sentTo: maskEmail(body.email), ...sent });
  }),
);

// ---------- one-time codes ----------
authRouter.post(
  '/resend-code',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ identifier: z.string({ required_error: 'Enter your email or phone' }).trim().min(3, 'Enter your email or phone'), purpose: purposeEnum }),
      req.body,
    );
    res.json(await sendFor(normalizeIdentifier(body.identifier), PURPOSES[body.purpose]));
  }),
);

authRouter.post(
  '/verify-code',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ identifier: z.string().trim().min(3, 'Something went wrong. Start again.'), purpose: purposeEnum, code, device }), req.body);
    const purpose = PURPOSES[body.purpose];
    const record = await verifyCode(normalizeIdentifier(body.identifier), purpose, body.code);
    const user = record.userId ? await prisma.user.findUnique({ where: { id: record.userId } }) : null;
    if (!user) throw Errors.notFound();

    if (purpose === 'RESET_PASSWORD') {
      res.json({ resetToken: signPurposeToken('reset', { sub: user.id }, 10 * 60) });
      return;
    }

    const now = new Date();
    const data: Prisma.UserUpdateInput = {};
    if (record.channel === 'SMS') data.phoneVerifiedAt = user.phoneVerifiedAt ?? now;
    else data.emailVerifiedAt = user.emailVerifiedAt ?? now;
    if (purpose === 'GOOGLE_PHONE') {
      data.phoneVerifiedAt = user.phoneVerifiedAt ?? now;
      data.emailVerifiedAt = user.emailVerifiedAt ?? now; // Google already verified the email
    }
    const updated = await prisma.user.update({ where: { id: user.id }, data });
    await prisma.notificationPref.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });

    res.json({ user: publicUser(updated), ...(await issueSession(updated, body.device)) });
  }),
);

// ---------- email + password login ----------
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email, password: z.string({ required_error: 'Enter your password' }).min(1, 'Enter your password'), device }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    if (!user) {
      await bcrypt.compare(body.password, DUMMY_HASH); // same timing whether or not the account exists
      throw Errors.invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw Errors.accountLocked((user.lockedUntil.getTime() - Date.now()) / 1000);
    if (!user.passwordHash) throw Errors.useGoogle();

    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      const maxTries = await getSetting('login_max_tries', 5);
      const lockMinutes = await getSetting('login_lock_minutes', 15);
      const failed = user.failedLogins + 1;
      if (failed >= maxTries) {
        await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + lockMinutes * 60 * 1000) } });
        throw Errors.accountLocked(lockMinutes * 60);
      }
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins: failed } });
      throw Errors.invalidCredentials(maxTries - failed);
    }

    if (user.status === 'SUSPENDED') throw new AppError(403, 'FORBIDDEN', 'This account is suspended. Contact support.');
    if (!isVerified(user)) {
      try {
        await sendFor(body.email, 'SIGNUP');
      } catch {
        // a code was sent a moment ago: the person can use that one
      }
      throw Errors.notVerified(body.email);
    }

    const fresh = user.failedLogins || user.lockedUntil ? await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } }) : user;
    res.json({ user: publicUser(fresh), ...(await issueSession(fresh, body.device)) });
  }),
);

// ---------- Google sign-in ----------
const googleClient = new OAuth2Client();

async function verifyGoogle(idToken: string) {
  if (config.googleClientIds.length === 0) throw new AppError(500, 'SERVER_ERROR', 'Google sign-in is not set up yet.');
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.googleClientIds });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email || !p.email_verified) throw new Error('incomplete Google profile');
    return { googleId: p.sub, email: p.email.toLowerCase(), name: p.name ?? p.email.split('@')[0], avatarUrl: p.picture };
  } catch {
    throw Errors.googleTokenInvalid();
  }
}

// Step 1: the app sends the Google ID token it got from the Google sign-in button.
// Returns one of: signed_in (done), needs_setup (new person: ask for phone), needs_verification (phone code pending).
authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ idToken: z.string().min(20), device }), req.body);
    const g = await verifyGoogle(body.idToken);

    const user = await prisma.user.findUnique({ where: { googleId: g.googleId } });
    if (user) {
      if (user.status === 'SUSPENDED') throw new AppError(403, 'FORBIDDEN', 'This account is suspended. Contact support.');
      if (user.phone && !user.phoneVerifiedAt) {
        if (!user.email) throw Errors.notFound();
        res.json({ status: 'needs_verification', ...(await sendFor(user.email, 'GOOGLE_PHONE')) });
        return;
      }
      if (user.phone) {
        res.json({ status: 'signed_in', user: publicUser(user), ...(await issueSession(user, body.device)) });
        return;
      }
    } else if (await prisma.user.findUnique({ where: { email: g.email } })) {
      throw Errors.googleAccountExists(g.email); // registered with a password: sign in once with it, then link Google
    }

    res.json({
      status: 'needs_setup',
      setupToken: signPurposeToken('google_setup', g, 15 * 60),
      profile: { name: g.name, email: g.email, avatarUrl: g.avatarUrl },
    });
  }),
);

// Step 2 (new people only): phone number, optional referral code and terms. Then a code is texted to the phone.
authRouter.post(
  '/google/complete',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ setupToken: z.string().min(10), phone, referralCode: z.string().trim().toUpperCase().optional(), acceptedTerms: terms }),
      req.body,
    );
    const g = verifyPurposeToken<{ googleId: string; email: string; name: string; avatarUrl?: string }>(body.setupToken, 'google_setup');

    const existing = await prisma.user.findUnique({ where: { googleId: g.googleId } });
    const emailOwner = await prisma.user.findUnique({ where: { email: g.email } });
    if (emailOwner && emailOwner.id !== existing?.id) throw Errors.googleAccountExists(g.email);
    const phoneOwner = await prisma.user.findUnique({ where: { phone: body.phone } });
    if (phoneOwner && phoneOwner.id !== existing?.id) throw Errors.phoneTaken();
    const referredById = await resolveReferral(body.referralCode);

    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: { phone: body.phone } })
      : await prisma.user.create({
          data: {
            email: g.email,
            name: g.name,
            googleId: g.googleId,
            avatarUrl: g.avatarUrl,
            phone: body.phone,
            emailVerifiedAt: new Date(),
            referralCode: await uniqueReferralCode(),
            referredById,
          },
        });

    const sent = await createCode({ userId: user.id, identifier: g.email, deliverTo: g.email, channel: 'EMAIL', purpose: 'GOOGLE_PHONE' });
    res.status(201).json({ next: 'verify', purpose: 'google_phone', target: g.email, channel: 'EMAIL', sentTo: maskEmail(g.email), ...sent });
  }),
);

// For someone who has a password account and wants to add Google (the "sign in with your password to link Google" screen).
authRouter.post(
  '/link-google',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ idToken: z.string().min(20) }), req.body);
    const g = await verifyGoogle(body.idToken);
    const me = await prisma.user.findUnique({ where: { id: userId(req) } });
    if (!me) throw Errors.notFound();
    if (me.email !== g.email) throw Errors.validation({ idToken: 'Use the Google account with the same email as your Dara\'s Hub account.' });
    const other = await prisma.user.findUnique({ where: { googleId: g.googleId } });
    if (other && other.id !== me.id) throw Errors.conflict('That Google account is linked to another profile.');
    await prisma.user.update({ where: { id: me.id }, data: { googleId: g.googleId, avatarUrl: me.avatarUrl ?? g.avatarUrl } });
    res.json({ ok: true });
  }),
);

// ---------- forgot / reset password ----------
authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ identifier: z.string({ required_error: 'Enter your email or phone' }).trim().min(3, 'Enter your email or phone') }),
      req.body,
    );
    res.json(await sendFor(normalizeIdentifier(body.identifier), 'RESET_PASSWORD'));
  }),
);

authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ resetToken: z.string().min(10), newPassword: password }), req.body);
    const token = verifyPurposeToken<{ sub: string }>(body.resetToken, 'reset');
    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: token.sub }, data: { passwordHash, failedLogins: 0, lockedUntil: null } }),
      prisma.session.updateMany({ where: { userId: token.sub, revokedAt: null }, data: { revokedAt: new Date() } }), // sign out other devices
    ]);
    res.json({ ok: true });
  }),
);

// ---------- sessions ----------
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    const session = await prisma.session.findUnique({ where: { tokenHash: hmac(body.refreshToken) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) throw Errors.sessionExpired();
    if (session.user.status === 'SUSPENDED') throw Errors.forbidden();
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }); // each refresh token works once
    res.json(await issueSession(session.user, session.device ?? undefined));
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
    await prisma.session.updateMany({ where: { tokenHash: hmac(body.refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    res.status(204).end();
  }),
);
