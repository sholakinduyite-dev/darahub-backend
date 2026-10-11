import { Router } from 'express';
import { z } from 'zod';
import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { requireAuth } from '../middleware/auth';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// The filter pills on the Notifications screen: All, Orders, Promos, Rewards, Replies.
const FILTERS: Record<string, NotificationType[] | undefined> = {
  all: undefined,
  orders: ['ORDER'],
  promos: ['PROMO'],
  rewards: ['REWARD'],
  replies: ['REPLY', 'SUPPORT'],
};

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const q = parse(
      z.object({ filter: z.enum(['all', 'orders', 'promos', 'rewards', 'replies']).default('all'), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
      req.query,
    );
    const types = FILTERS[q.filter];
    const where: Prisma.NotificationWhereInput = { userId: uid, ...(types ? { type: { in: types } } : {}) };
    const rows = await prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const unreadCount = await prisma.notification.count({ where: { userId: uid, readAt: null } });
    res.json({ items, unreadCount, nextCursor: hasMore ? items[items.length - 1].id : null });
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ unreadCount: await prisma.notification.count({ where: { userId: userId(req), readAt: null } }) });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: userId(req), readAt: null }, data: { readAt: new Date() } });
    res.status(204).end();
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({ where: { id: req.params.id, userId: userId(req), readAt: null }, data: { readAt: new Date() } });
    if (result.count === 0) {
      const exists = await prisma.notification.findFirst({ where: { id: req.params.id, userId: userId(req) } });
      if (!exists) throw Errors.notFound();
    }
    res.status(204).end();
  }),
);
