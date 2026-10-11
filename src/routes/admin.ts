import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { requireAuth, requireRole } from '../middleware/auth';
import { notifyUser } from '../services/notify';
import { confirmPayment, releaseOrderHolds } from '../services/commerce';
import { orderRef } from '../services/orderStatus';

export const paymentRouter = Router();
paymentRouter.use(requireAuth);

paymentRouter.post('/:reference/initiate', asyncHandler(async (req, res) => {
  const body = parse(z.object({ email: z.string().email() }), req.body);
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findFirst({ where: { number, OR: [{ userId: req.user?.id }, { guestEmail: body.email }] }, include: { payments: true } });
  if (!order) throw Errors.notFound();
  if (!['PAYSTACK', 'POCKETFI'].includes(order.paymentMethod)) throw Errors.conflict('This order uses direct transfer.');
  const payment = order.payments[0];
  if (order.paymentMethod === 'PAYSTACK') {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return res.json({ provider: 'PAYSTACK', reference: payment.reference, paymentUrl: null, requiresConfiguration: true });
    const response = await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: body.email, amount: payment.amount, reference: payment.reference, callback_url: process.env.PAYSTACK_CALLBACK_URL }) });
    const json = await response.json() as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string } };
    if (!response.ok || !json.status || !json.data?.authorization_url) throw new Error(json.message ?? 'Paystack initialization failed');
    return res.json({ provider: 'PAYSTACK', reference: payment.reference, paymentUrl: json.data.authorization_url, accessCode: json.data.access_code });
  }
  const apiKey = process.env.POCKETFI_API_KEY;
  const endpoint = process.env.POCKETFI_CHECKOUT_URL;
  if (!apiKey || !endpoint) return res.json({ provider: 'POCKETFI', reference: payment.reference, paymentUrl: null, requiresConfiguration: true });
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: payment.amount, reference: payment.reference, email: body.email, callbackUrl: process.env.POCKETFI_CALLBACK_URL }) });
  const json = await response.json() as { checkoutUrl?: string; paymentUrl?: string };
  if (!response.ok || !(json.checkoutUrl ?? json.paymentUrl)) throw new Error('PocketFi checkout initialization failed');
  res.json({ provider: 'POCKETFI', reference: payment.reference, paymentUrl: json.checkoutUrl ?? json.paymentUrl });
}));

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('OWNER', 'MANAGER', 'PACKER', 'SUPPORT'));

adminRouter.get('/orders', asyncHandler(async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const where = q.status ? { status: q.status as never } : {};
  const [total, rows] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { items: true, payments: true, receipts: { orderBy: { createdAt: 'desc' }, take: 1 }, user: { select: { id: true, name: true, email: true, phone: true } } } }),
  ]);
  res.json({ items: rows.map((row) => ({ ...row, reference: orderRef(row.number) })), total, page: q.page });
}));

adminRouter.post('/orders/:reference/status', requireRole('OWNER', 'MANAGER', 'PACKER'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) }), req.body);
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findUnique({ where: { number } });
  if (!order) throw Errors.notFound();
  const allowed: Record<string, string[]> = { PAYMENT_CONFIRMED: ['PACKED', 'CANCELLED'], PACKED: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'] };
  if (!allowed[order.status]?.includes(body.status)) throw Errors.conflict(`Cannot move ${order.status} to ${body.status}.`);
  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: body.status, deliveredAt: body.status === 'DELIVERED' ? new Date() : undefined, cancelledAt: body.status === 'CANCELLED' ? new Date() : undefined, events: { create: { type: 'status_changed', fromStatus: order.status, toStatus: body.status, actorType: 'STAFF', actorId: userId(req) } } } });
  if (body.status === 'CANCELLED') await releaseOrderHolds(order.id);
  if (order.userId) await notifyUser({ userId: order.userId, type: 'ORDER', title: `Order ${orderRef(order.number)}`, body: `Your order status is now ${body.status.toLowerCase()}.`, deepLink: `order/${orderRef(order.number)}` });
  res.json({ ...updated, reference: orderRef(updated.number) });
}));

adminRouter.post('/transfers/:id/decision', requireRole('OWNER', 'MANAGER'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), rejectReason: z.string().trim().max(300).optional() }), req.body);
  const receipt = await prisma.transferReceipt.findUnique({ where: { id: req.params.id }, include: { order: true } });
  if (!receipt || receipt.status !== 'PENDING') throw Errors.notFound();
  const nextStatus = body.decision === 'APPROVED' ? 'PAYMENT_CONFIRMED' : 'TRANSFER_REJECTED';
  await prisma.transferReceipt.update({ where: { id: receipt.id }, data: { status: body.decision, rejectReason: body.rejectReason, reviewedById: userId(req), reviewedAt: new Date() } });
  if (body.decision === 'APPROVED') await confirmPayment(receipt.orderId);
  else await prisma.order.update({ where: { id: receipt.orderId }, data: { status: nextStatus, events: { create: { type: 'transfer_decision', fromStatus: receipt.order.status, toStatus: nextStatus, actorType: 'STAFF', actorId: userId(req), note: body.rejectReason } } } });
  if (receipt.order.userId) await notifyUser({ userId: receipt.order.userId, type: 'ORDER', title: body.decision === 'APPROVED' ? 'Transfer approved' : 'Transfer needs attention', body: body.decision === 'APPROVED' ? `Payment confirmed for ${orderRef(receipt.order.number)}.` : (body.rejectReason ?? 'Please upload a clearer receipt.'), deepLink: `order/${orderRef(receipt.order.number)}` });
  res.json({ ok: true, status: nextStatus });
}));

adminRouter.get('/transfers/pending', requireRole('OWNER', 'MANAGER'), asyncHandler(async (_req, res) => {
  res.json({ items: await prisma.transferReceipt.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, include: { order: { include: { user: { select: { name: true, email: true } } } } } }) });
}));
