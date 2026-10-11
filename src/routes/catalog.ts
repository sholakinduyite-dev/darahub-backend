import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse } from '../http';
import { optionalAuth } from '../middleware/auth';
import { heldByVariant } from '../services/availability';

export const catalogRouter = Router();

catalogRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.category.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: { where: { status: 'PUBLISHED' } } } } },
    });
    res.json({ items: rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, imageUrl: c.imageUrl, productCount: c._count.products })) });
  }),
);

catalogRouter.get(
  '/banners',
  asyncHandler(async (_req, res) => {
    res.json({ items: await prisma.banner.findMany({ where: { active: true }, orderBy: { sort: 'asc' } }) });
  }),
);

catalogRouter.get(
  '/delivery-zones',
  asyncHandler(async (_req, res) => {
    res.json({ items: await prisma.deliveryZone.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, fee: true, etaDays: true } }) });
  }),
);

// Shape used by every product grid in the app (Home, Search, Favorites).
export const cardInclude = {
  images: { orderBy: { sort: 'asc' }, take: 1 },
  variants: { select: { stock: true } },
} satisfies Prisma.ProductInclude;

export type ProductCardRow = Prisma.ProductGetPayload<{ include: typeof cardInclude }>;

export function toCard(p: ProductCardRow) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    price: p.price,
    salePrice: p.salePrice,
    isNewArrival: p.isNewArrival,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    imageUrl: p.images[0]?.url ?? null,
    inStock: p.variants.some((v) => v.stock > 0),
  };
}

const listQuery = z.object({
  q: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  sort: z.enum(['popular', 'newest', 'price_asc', 'price_desc']).default('popular'),
  minPrice: z.coerce.number().int().min(0).optional(), // in kobo
  maxPrice: z.coerce.number().int().min(0).optional(), // in kobo
  size: z.string().trim().min(1).optional(),
  onSale: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ORDER_BY: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  popular: [{ soldCount: 'desc' }, { ratingCount: 'desc' }, { createdAt: 'desc' }],
  newest: [{ createdAt: 'desc' }],
  price_asc: [{ price: 'asc' }],
  price_desc: [{ price: 'desc' }],
};

// Home, search results and category pages all use this one endpoint.
catalogRouter.get(
  '/products',
  asyncHandler(async (req, res) => {
    const q = parse(listQuery, req.query);
    const where: Prisma.ProductWhereInput = { status: 'PUBLISHED' };
    if (q.q) where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }];
    if (q.category) where.category = { slug: q.category };
    if (q.minPrice !== undefined || q.maxPrice !== undefined) where.price = { gte: q.minPrice, lte: q.maxPrice };
    if (q.size) where.variants = { some: { size: q.size, stock: { gt: 0 } } };
    if (q.onSale === 'true') where.salePrice = { not: null };

    const [total, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy: ORDER_BY[q.sort], skip: (q.page - 1) * q.limit, take: q.limit, include: cardInclude }),
    ]);
    res.json({ items: rows.map(toCard), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  }),
);

catalogRouter.get(
  '/products/:slug',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { slug: req.params.slug, status: 'PUBLISHED' },
      include: { images: { orderBy: { sort: 'asc' } }, variants: { orderBy: [{ size: 'asc' }, { color: 'asc' }] }, category: true },
    });
    if (!product) throw Errors.notFound();

    const held = await heldByVariant(product.variants.map((v) => v.id));
    const ratings = await prisma.review.groupBy({ by: ['rating'], where: { productId: product.id, status: 'VISIBLE' }, _count: { rating: true } });
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) distribution[r.rating] = r._count.rating;

    const isFavorite = req.user ? Boolean(await prisma.favorite.findUnique({ where: { userId_productId: { userId: req.user.id, productId: product.id } } })) : false;

    res.json({
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: product.price,
      salePrice: product.salePrice,
      isNewArrival: product.isNewArrival,
      ratingAvg: product.ratingAvg,
      ratingCount: product.ratingCount,
      ratingDistribution: distribution,
      category: { id: product.category.id, name: product.category.name, slug: product.category.slug },
      images: product.images.map((i) => ({ id: i.id, url: i.url })),
      variants: product.variants.map((v) => ({ id: v.id, size: v.size, color: v.color, available: Math.max(0, v.stock - (held.get(v.id) ?? 0)) })),
      isFavorite,
    });
  }),
);

// Search box suggestions while typing.
catalogRouter.get(
  '/search/suggest',
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().min(2) }), req.query);
    const rows = await prisma.product.findMany({
      where: { status: 'PUBLISHED', name: { contains: q.q, mode: 'insensitive' } },
      select: { name: true, slug: true },
      orderBy: { soldCount: 'desc' },
      take: 6,
    });
    res.json({ items: rows });
  }),
);
