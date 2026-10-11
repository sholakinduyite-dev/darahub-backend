import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { normalizePhone, publicUser } from '../lib/identity';
import { requireAuth } from '../middleware/auth';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: userId(req) } });
    if (!user) throw Errors.sessionExpired();
    const unreadNotifications = await prisma.notification.count({ where: { userId: user.id, readAt: null } });
    res.json({ user: publicUser(user), unreadNotifications });
  }),
);

meRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2, 'Enter your full name').optional(), avatarUrl: z.string().url().nullable().optional() }), req.body);
    const user = await prisma.user.update({ where: { id: userId(req) }, data: body });
    res.json({ user: publicUser(user) });
  }),
);

// ---------- addresses ----------
const phone = z.string().trim().refine((v) => normalizePhone(v) !== null, 'Enter an 11-digit phone number').transform((v) => normalizePhone(v) as string);
const addressFields = z.object({
  label: z.string().trim().min(1).max(30),
  recipient: z.string().trim().min(2, "Enter the receiver's name"),
  phone,
  line1: z.string().trim().min(3, 'Enter the street address'),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(2, 'Enter the city'),
  state: z.string().trim().min(2, 'Enter the state'),
  zoneId: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

meRouter.get(
  '/addresses',
  asyncHandler(async (req, res) => {
    const items = await prisma.address.findMany({ where: { userId: userId(req) }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }], include: { zone: true } });
    res.json({ items });
  }),
);

meRouter.post(
  '/addresses',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = parse(addressFields.extend({ label: z.string().trim().min(1).max(30).optional() }), req.body);
    const count = await prisma.address.count({ where: { userId: uid } });
    const makeDefault = body.isDefault ?? count === 0;
    if (makeDefault) await prisma.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
    const item = await prisma.address.create({ data: { ...body, label: body.label ?? 'Home', userId: uid, isDefault: makeDefault } });
    res.status(201).json({ item });
  }),
);

meRouter.patch(
  '/addresses/:id',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = parse(addressFields.partial(), req.body);
    const owned = await prisma.address.findFirst({ where: { id: req.params.id, userId: uid } });
    if (!owned) throw Errors.notFound();
    if (body.isDefault) await prisma.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
    const item = await prisma.address.update({ where: { id: owned.id }, data: body });
    res.json({ item });
  }),
);

meRouter.delete(
  '/addresses/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.address.deleteMany({ where: { id: req.params.id, userId: userId(req) } });
    if (result.count === 0) throw Errors.notFound();
    res.status(204).end();
  }),
);

// ---------- push notification devices ----------
meRouter.post(
  '/devices',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), platform: z.enum(['ANDROID', 'IOS']) }), req.body);
    await prisma.deviceToken.upsert({
      where: { token: body.token },
      create: { userId: userId(req), token: body.token, platform: body.platform },
      update: { userId: userId(req), platform: body.platform, lastSeenAt: new Date() },
    });
    res.status(204).end();
  }),
);

meRouter.delete(
  '/devices/:token',
  asyncHandler(async (req, res) => {
    await prisma.deviceToken.deleteMany({ where: { token: req.params.token, userId: userId(req) } });
    res.status(204).end();
  }),
);

// ---------- notification settings screen ----------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00').nullable();

meRouter.get(
  '/notification-preferences',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const pref = await prisma.notificationPref.upsert({ where: { userId: uid }, create: { userId: uid }, update: {} });
    res.json({ preferences: pref });
  }),
);

meRouter.put(
  '/notification-preferences',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = parse(
      z.object({
        push: z.boolean().optional(),
        orders: z.boolean().optional(),
        promos: z.boolean().optional(),
        rewards: z.boolean().optional(),
        replies: z.boolean().optional(),
        support: z.boolean().optional(),
        quietStart: hhmm.optional(),
        quietEnd: hhmm.optional(),
      }),
      req.body,
    );
    const pref = await prisma.notificationPref.upsert({ where: { userId: uid }, create: { userId: uid, ...body }, update: body });
    res.json({ preferences: pref });
  }),
);
