import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse, userId } from '../http';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { addCartItem, applyPromo, cartView, getOrCreateCart, setCartItem, createCheckout } from '../services/commerce';

export const cartRouter = Router();

function owner(req: import('express').Request) {
  return req.user ? { userId: req.user.id } : { guestToken: String(req.header('x-cart-token') ?? '') || undefined };
}

cartRouter.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const current = owner(req);
  const data = await cartView(current);
  res.json({ ...data, guestToken: current.guestToken ?? null });
}));

cartRouter.post('/items', optionalAuth, asyncHandler(async (req, res) => {
  const body = parse(z.object({ variantId: z.string().min(1), qty: z.number().int().min(1).max(99) }), req.body);
  res.status(201).json(await addCartItem(owner(req), body.variantId, body.qty));
}));

cartRouter.patch('/items/:variantId', optionalAuth, asyncHandler(async (req, res) => {
  const body = parse(z.object({ qty: z.number().int().min(0).max(99) }), req.body);
  res.json(await setCartItem(owner(req), req.params.variantId, body.qty));
}));

cartRouter.delete('/items/:variantId', optionalAuth, asyncHandler(async (req, res) => {
  res.json(await setCartItem(owner(req), req.params.variantId, 0));
}));

cartRouter.post('/promo', optionalAuth, asyncHandler(async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().min(2).max(40) }), req.body);
  res.json(await applyPromo(owner(req), body.code));
}));

cartRouter.post('/checkout', optionalAuth, asyncHandler(async (req, res) => {
  const body = parse(z.object({
    paymentMethod: z.enum(['PAYSTACK', 'POCKETFI', 'TRANSFER']),
    addressSnapshot: z.object({ recipient: z.string().min(1), phone: z.string().min(7), line1: z.string().min(1), line2: z.string().optional(), city: z.string().min(1), state: z.string().min(1) }),
    zoneId: z.string().optional(),
    guestName: z.string().min(1).optional(),
    guestEmail: z.string().email().optional(),
    guestPhone: z.string().min(7).optional(),
    pointsUsed: z.number().int().min(0).optional(),
  }), req.body);
  if (!req.user && (!body.guestName || !body.guestEmail || !body.guestPhone)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Guest checkout needs your name, email and phone.', details: { fields: { guestName: 'Required for guest checkout' } }, requestId: req.id } });
    return;
  }
  const result = await createCheckout({ owner: owner(req), ...body });
  const cart = await getOrCreateCart(owner(req));
  res.status(201).json({ order: result.order, reference: result.reference, holdExpiresAt: result.holdExpiresAt, cartId: cart.id });
}));

cartRouter.post('/merge', requireAuth, asyncHandler(async (req, res) => {
  const token = parse(z.object({ guestToken: z.string().min(10) }), req.body).guestToken;
  const guest = await getOrCreateCart({ guestToken: token });
  const signedIn = await getOrCreateCart({ userId: userId(req) });
  for (const item of guest.items) {
    const existing = signedIn.items.find((row) => row.variantId === item.variantId);
    if (existing) await setCartItem({ userId: userId(req) }, item.variantId, existing.qty + item.qty);
    else await addCartItem({ userId: userId(req) }, item.variantId, item.qty);
  }
  await prismaCartDelete(guest.id);
  res.json(await cartView({ userId: userId(req) }));
}));

async function prismaCartDelete(id: string) {
  const { prisma } = await import('../db');
  await prisma.cart.delete({ where: { id } });
}
