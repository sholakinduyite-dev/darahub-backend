import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { Errors } from '../errors';
import { asyncHandler, parse, userId } from '../http';
import { requireAuth } from '../middleware/auth';
import { notifyUser } from '../services/notify';
import { confirmPayment, releaseOrderHolds } from '../services/commerce';
import { orderRef } from '../services/orderStatus';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const orderInclude = { items: true, payments: true, receipts: { orderBy: { createdAt: 'desc' as const } }, events: { orderBy: { createdAt: 'asc' as const } } };

ordersRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await prisma.order.findMany({ where: { userId: userId(req) }, orderBy: { createdAt: 'desc' }, include: { items: true, payments: true } });
  res.json({ items: rows.map((row) => ({ ...row, reference: orderRef(row.number) })) });
}));

ordersRouter.get('/:reference', asyncHandler(async (req, res) => {
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findFirst({ where: { number, userId: userId(req) }, include: orderInclude });
  if (!order) throw Errors.notFound();
  res.json({ ...order, reference: orderRef(order.number) });
}));

ordersRouter.post('/:reference/cancel', asyncHandler(async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body);
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findFirst({ where: { number, userId: userId(req) } });
  if (!order) throw Errors.notFound();
  if (!['AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'PAYMENT_FAILED', 'TRANSFER_REJECTED', 'PAYMENT_CONFIRMED'].includes(order.status)) throw Errors.conflict('This order can no longer be cancelled.');
  await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason, events: { create: { type: 'status_changed', fromStatus: order.status, toStatus: 'CANCELLED', actorType: 'CUSTOMER', actorId: userId(req), note: body.reason } } } });
  await releaseOrderHolds(order.id);
  res.json({ ok: true, reference: orderRef(order.number) });
}));

ordersRouter.post('/:reference/transfer-receipt', asyncHandler(async (req, res) => {
  const body = parse(z.object({ imageUrl: z.string().url(), amountOnReceipt: z.number().int().positive().optional() }), req.body);
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findFirst({ where: { number, userId: userId(req) } });
  if (!order) throw Errors.notFound();
  if (order.paymentMethod !== 'TRANSFER' || !['AWAITING_PAYMENT', 'TRANSFER_REJECTED'].includes(order.status)) throw Errors.conflict('This order is not waiting for a transfer receipt.');
  const receipt = await prisma.transferReceipt.create({ data: { orderId: order.id, imageUrl: body.imageUrl, amountOnReceipt: body.amountOnReceipt } });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'AWAITING_APPROVAL', events: { create: { type: 'receipt_uploaded', fromStatus: order.status, toStatus: 'AWAITING_APPROVAL', actorType: 'CUSTOMER', actorId: userId(req) } } } });
  res.status(201).json({ receipt, reference: orderRef(order.number) });
}));

ordersRouter.post('/:reference/confirm-delivery', asyncHandler(async (req, res) => {
  const number = Number(req.params.reference.replace(/^DH-/i, ''));
  const order = await prisma.order.findFirst({ where: { number, userId: userId(req), status: 'DELIVERED' } });
  if (!order) throw Errors.notFound();
  const updated = await prisma.order.update({ where: { id: order.id }, data: { receiptConfirmedAt: new Date() } });
  res.json(updated);
}));

export const paymentWebhookRouter = Router();

function safeEqual(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

paymentWebhookRouter.post('/paystack', asyncHandler(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.header('x-paystack-signature');
  if (!secret || !safeEqual(signature, crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex'))) return res.status(401).json({ ok: false });
  const data = req.body?.data;
  if (req.body?.event === 'charge.success' && data?.reference) {
    const payment = await prisma.payment.findUnique({ where: { reference: String(data.reference) } });
    if (payment && Number(data.amount) === payment.amount) await confirmPayment(payment.orderId, req.body);
  }
  res.json({ received: true });
}));

paymentWebhookRouter.post('/pocketfi', asyncHandler(async (req, res) => {
  const secret = process.env.POCKETFI_WEBHOOK_SECRET;
  const signature = req.header('x-pocketfi-signature');
  if (!secret || !safeEqual(signature, crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex'))) return res.status(401).json({ ok: false });
  const reference = String(req.body?.reference ?? '');
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (payment && req.body?.status === 'success' && Number(req.body?.amount) === payment.amount) await confirmPayment(payment.orderId, req.body);
  res.json({ received: true });
}));
