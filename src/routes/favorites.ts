import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { requireAuth } from '../middleware/auth';
import { cardInclude, toCard } from './catalog';

export const favoritesRouter = Router();
favoritesRouter.use(requireAuth);

favoritesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.favorite.findMany({
      where: { userId: userId(req) },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: cardInclude } },
    });
    const items = rows
      .filter((f) => f.product.status === 'PUBLISHED')
      .map((f) => {
        const price = f.product.salePrice ?? f.product.price;
        return { ...toCard(f.product), alertOn: f.alertOn, priceAtSave: f.priceAtSave, priceDropped: price < f.priceAtSave };
      });
    res.json({ items });
  }),
);

favoritesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ productId: z.string().min(1) }), req.body);
    const product = await prisma.product.findFirst({ where: { id: body.productId, status: 'PUBLISHED' } });
    if (!product) throw Errors.notFound();
    await prisma.favorite.upsert({
      where: { userId_productId: { userId: userId(req), productId: product.id } },
      create: { userId: userId(req), productId: product.id, priceAtSave: product.salePrice ?? product.price },
      update: {},
    });
    res.status(201).json({ ok: true });
  }),
);

favoritesRouter.delete(
  '/:productId',
  asyncHandler(async (req, res) => {
    await prisma.favorite.deleteMany({ where: { userId: userId(req), productId: req.params.productId } });
    res.status(204).end();
  }),
);
