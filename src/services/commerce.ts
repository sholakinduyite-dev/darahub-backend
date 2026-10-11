import crypto from 'crypto';
import type { PaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { Errors } from '../errors';
import { getSetting } from './settings';
import { orderRef } from './orderStatus';

export type CartOwner = { userId?: string; guestToken?: string };

const cartInclude = {
  promoCode: true,
  items: {
    include: {
      variant: { include: { product: { include: { images: { orderBy: { sort: 'asc' }, take: 1 } } } } },
    },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.CartInclude;

export type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

function ownerWhere(owner: CartOwner): Prisma.CartWhereInput {
  if (owner.userId) return { userId: owner.userId };
  if (owner.guestToken) return { guestToken: owner.guestToken };
  return { id: '__empty__' };
}

export async function getOrCreateCart(owner: CartOwner): Promise<CartWithItems> {
  if (!owner.userId && !owner.guestToken) {
    return { id: '', userId: null, guestToken: null, promoCodeId: null, updatedAt: new Date(), promoCode: null, items: [] } as CartWithItems;
  }
  const existing = await prisma.cart.findFirst({ where: ownerWhere(owner), include: cartInclude });
  if (existing) return existing;
  return prisma.cart.create({ data: owner.userId ? { userId: owner.userId } : { guestToken: owner.guestToken }, include: cartInclude });
}

async function activeHeld(variantId: string, excludeUser?: CartOwner) {
  const rows = await prisma.stockHold.aggregate({
    _sum: { qty: true },
    where: {
      variantId,
      releasedAt: null,
      expiresAt: { gt: new Date() },
      ...(excludeUser?.userId ? { userId: { not: excludeUser.userId } } : {}),
      ...(excludeUser?.guestToken ? { guestToken: { not: excludeUser.guestToken } } : {}),
    },
  });
  return rows._sum.qty ?? 0;
}

export async function cartView(owner: CartOwner) {
  const cart = await getOrCreateCart(owner);
  const items = await Promise.all(cart.items.map(async (item) => {
    const held = await activeHeld(item.variantId, owner);
    const available = Math.max(0, item.variant.stock - held);
    const unitPrice = item.variant.product.salePrice ?? item.variant.product.price;
    return {
      id: item.id,
      variantId: item.variantId,
      qty: item.qty,
      available,
      product: {
        id: item.variant.product.id,
        name: item.variant.product.name,
        slug: item.variant.product.slug,
        size: item.variant.size,
        color: item.variant.color,
        imageUrl: item.variant.product.images[0]?.url ?? null,
        unitPrice,
      },
      lineTotal: unitPrice * item.qty,
    };
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = calculateDiscount(cart.promoCode, subtotal);
  return { id: cart.id, items, promoCode: cart.promoCode?.code ?? null, subtotal, discount, totalBeforeDelivery: subtotal - discount };
}

function calculateDiscount(promo: CartWithItems['promoCode'], subtotal: number) {
  if (!promo || subtotal < promo.minSpend) return 0;
  return promo.type === 'PERCENT' ? Math.min(subtotal, Math.floor((subtotal * promo.value) / 100)) : Math.min(subtotal, promo.value);
}

export async function addCartItem(owner: CartOwner, variantId: string, qty: number) {
  const variant = await prisma.variant.findUnique({ where: { id: variantId }, include: { product: true } });
  if (!variant || variant.product.status !== 'PUBLISHED') throw Errors.notFound();
  const cart = await getOrCreateCart(owner);
  const current = cart.items.find((item) => item.variantId === variantId)?.qty ?? 0;
  const available = Math.max(0, variant.stock - (await activeHeld(variantId, owner)));
  if (current + qty > available) throw Errors.outOfStock(available);
  await prisma.cartItem.upsert({ where: { cartId_variantId: { cartId: cart.id, variantId } }, update: { qty: current + qty }, create: { cartId: cart.id, variantId, qty } });
  return cartView(owner);
}

export async function setCartItem(owner: CartOwner, variantId: string, qty: number) {
  const cart = await getOrCreateCart(owner);
  const item = cart.items.find((row) => row.variantId === variantId);
  if (!item) throw Errors.notFound();
  if (qty === 0) await prisma.cartItem.delete({ where: { id: item.id } });
  else {
    const variant = await prisma.variant.findUnique({ where: { id: variantId } });
    if (!variant) throw Errors.notFound();
    const available = Math.max(0, variant.stock - (await activeHeld(variantId, owner)));
    if (qty > available) throw Errors.outOfStock(available);
    await prisma.cartItem.update({ where: { id: item.id }, data: { qty } });
  }
  return cartView(owner);
}

export async function applyPromo(owner: CartOwner, code: string) {
  const cart = await getOrCreateCart(owner);
  const promo = await prisma.promoCode.findUnique({ where: { code: code.trim().toUpperCase() } });
  const now = new Date();
  if (!promo || !promo.active || (promo.startsAt && promo.startsAt > now) || (promo.endsAt && promo.endsAt < now) || (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit)) {
    throw Errors.conflict('That promo code is not available.');
  }
  await prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id } });
  return cartView(owner);
}

export async function createCheckout(input: {
  owner: CartOwner;
  paymentMethod: PaymentMethod;
  addressSnapshot: Prisma.InputJsonValue;
  zoneId?: string;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  pointsUsed?: number;
}) {
  const holdMinutes = await getSetting('stock_hold_minutes', 10);
  const unpaidHours = await getSetting('unpaid_order_hours', 24);
  const cart = await getOrCreateCart(input.owner);
  if (cart.items.length === 0) throw Errors.conflict('Your cart is empty.');
  const zone = input.zoneId ? await prisma.deliveryZone.findFirst({ where: { id: input.zoneId, active: true } }) : null;
  if (input.zoneId && !zone) throw Errors.validation({ zoneId: 'Choose an available delivery zone.' });
  const totals = await cartView(input.owner);
  const pointsUsed = Math.max(0, input.pointsUsed ?? 0);
  if (pointsUsed > 0 && !input.owner.userId) throw Errors.validation({ pointsUsed: 'Sign in to use reward points.' });
  if (input.owner.userId) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: input.owner.userId }, select: { pointsBalance: true } });
    if (pointsUsed > user.pointsBalance) throw Errors.validation({ pointsUsed: 'You do not have enough reward points.' });
  }
  const pointValue = pointsUsed; // 1 point = 1 kobo; owner can change the reward policy later.
  const deliveryFee = zone?.fee ?? 0;
  const total = Math.max(0, totals.totalBeforeDelivery + deliveryFee - pointValue);
  const expiresAt = new Date(Date.now() + Number(holdMinutes) * 60_000);
  const unpaidExpiresAt = new Date(Date.now() + Number(unpaidHours) * 3_600_000);

  const order = await prisma.$transaction(async (tx) => {
    for (const item of cart.items) {
      const variant = await tx.variant.findUnique({ where: { id: item.variantId }, include: { product: { include: { images: { orderBy: { sort: 'asc' }, take: 1 } } } } });
      if (!variant) throw Errors.notFound();
      const held = await tx.stockHold.aggregate({ _sum: { qty: true }, where: { variantId: item.variantId, releasedAt: null, expiresAt: { gt: new Date() } } });
      const available = Math.max(0, variant.stock - (held._sum.qty ?? 0));
      if (item.qty > available) throw Errors.outOfStock(available);
    }
    const created = await tx.order.create({
      data: {
        userId: input.owner.userId,
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        guestPhone: input.guestPhone,
        subtotal: totals.subtotal,
        deliveryFee,
        discount: totals.discount,
        pointsUsed,
        total,
        promoCodeId: cart.promoCode?.id,
        paymentMethod: input.paymentMethod,
        zoneId: zone?.id,
        addressSnapshot: input.addressSnapshot,
        unpaidExpiresAt,
        items: { create: cart.items.map((item) => ({ variantId: item.variantId, productName: item.variant.product.name, size: item.variant.size, color: item.variant.color, imageUrl: item.variant.product.images[0]?.url, unitPrice: item.variant.product.salePrice ?? item.variant.product.price, qty: item.qty })) },
        events: { create: { type: 'created', actorType: input.owner.userId ? 'CUSTOMER' : 'SYSTEM', actorId: input.owner.userId } },
        holds: { create: cart.items.map((item) => ({ variantId: item.variantId, qty: item.qty, userId: input.owner.userId, guestToken: input.owner.guestToken, expiresAt })) },
        payments: { create: { provider: input.paymentMethod, reference: `DH-${crypto.randomBytes(10).toString('hex')}`, amount: total } },
      },
      include: { items: true, payments: true },
    });
    if (input.owner.userId && pointsUsed > 0) {
      await tx.user.update({ where: { id: input.owner.userId }, data: { pointsBalance: { decrement: pointsUsed }, rewardEntries: { create: { points: -pointsUsed, reason: 'REDEEM', note: `Used on ${orderRef(created.number)}` } } } });
    }
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return created;
  }, { isolationLevel: 'Serializable' });
  return { order, reference: orderRef(order.number), holdExpiresAt: expiresAt };
}

export async function releaseOrderHolds(orderId: string) {
  await prisma.stockHold.updateMany({ where: { orderId, releasedAt: null }, data: { releasedAt: new Date() } });
}

export async function confirmPayment(orderId: string, raw?: Prisma.InputJsonValue) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true, items: true } });
  if (!order) throw Errors.notFound();
  if (order.status === 'PAYMENT_CONFIRMED' || order.status === 'PACKED' || order.status === 'SHIPPED' || order.status === 'DELIVERED') return order;
  const payment = order.payments[0];
  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const updated = await tx.variant.updateMany({ where: { id: item.variantId, stock: { gte: item.qty } }, data: { stock: { decrement: item.qty } } });
      if (updated.count !== 1) throw Errors.outOfStock(0);
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCESS', paidAt: new Date(), raw } });
    await tx.stockHold.updateMany({ where: { orderId: order.id, releasedAt: null }, data: { releasedAt: new Date() } });
    await tx.order.update({ where: { id: order.id }, data: { status: 'PAYMENT_CONFIRMED', events: { create: { type: 'status_changed', fromStatus: order.status, toStatus: 'PAYMENT_CONFIRMED', actorType: 'SYSTEM' } } } });
  });
  return prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payments: true } });
}
