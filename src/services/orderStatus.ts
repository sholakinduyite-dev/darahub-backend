import type { OrderStatus } from '@prisma/client';

export type Actor = 'CUSTOMER' | 'STAFF' | 'SYSTEM';

// The order status rules from the "Order status map" wireframe. Status only moves along these arrows.
const RULES: { from: OrderStatus; to: OrderStatus; by: Actor[] }[] = [
  // payment
  { from: 'AWAITING_PAYMENT', to: 'AWAITING_APPROVAL', by: ['CUSTOMER'] }, // uploaded a transfer receipt
  { from: 'AWAITING_PAYMENT', to: 'PAYMENT_CONFIRMED', by: ['SYSTEM'] }, // Paystack / PocketFi success
  { from: 'AWAITING_PAYMENT', to: 'PAYMENT_FAILED', by: ['SYSTEM'] },
  { from: 'AWAITING_APPROVAL', to: 'PAYMENT_CONFIRMED', by: ['STAFF'] },
  { from: 'AWAITING_APPROVAL', to: 'TRANSFER_REJECTED', by: ['STAFF'] },
  { from: 'PAYMENT_FAILED', to: 'AWAITING_PAYMENT', by: ['CUSTOMER'] }, // try again
  { from: 'TRANSFER_REJECTED', to: 'AWAITING_APPROVAL', by: ['CUSTOMER'] }, // new receipt
  // fulfilment
  { from: 'PAYMENT_CONFIRMED', to: 'PACKED', by: ['STAFF'] },
  { from: 'PACKED', to: 'SHIPPED', by: ['STAFF'] },
  { from: 'SHIPPED', to: 'DELIVERED', by: ['STAFF'] },
  // cancelling
  { from: 'AWAITING_PAYMENT', to: 'CANCELLED', by: ['CUSTOMER', 'STAFF', 'SYSTEM'] },
  { from: 'AWAITING_APPROVAL', to: 'CANCELLED', by: ['CUSTOMER', 'STAFF'] },
  { from: 'PAYMENT_FAILED', to: 'CANCELLED', by: ['CUSTOMER', 'STAFF', 'SYSTEM'] },
  { from: 'TRANSFER_REJECTED', to: 'CANCELLED', by: ['CUSTOMER', 'STAFF', 'SYSTEM'] },
  { from: 'PAYMENT_CONFIRMED', to: 'CANCELLED', by: ['CUSTOMER', 'STAFF'] }, // customers only before packing
  { from: 'PACKED', to: 'CANCELLED', by: ['STAFF'] },
  // money back
  { from: 'DELIVERED', to: 'REFUNDED', by: ['STAFF'] },
  { from: 'CANCELLED', to: 'REFUNDED', by: ['STAFF'] },
];

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return RULES.some((r) => r.from === from && r.to === to && r.by.includes(actor));
}

export function allowedNext(from: OrderStatus, actor: Actor): OrderStatus[] {
  return RULES.filter((r) => r.from === from && r.by.includes(actor)).map((r) => r.to);
}

export function orderRef(number: number): string {
  return `DH-${String(number).padStart(4, '0')}`;
}

// The message the customer receives for each new status (from the status map). null means no message.
export function customerMessage(status: OrderStatus, ref: string, extra?: { rider?: string; reason?: string }) {
  switch (status) {
    case 'AWAITING_APPROVAL':
      return { title: 'We got your receipt', body: `We're checking your transfer for ${ref}.` };
    case 'PAYMENT_CONFIRMED':
      return { title: 'Payment confirmed', body: `Payment confirmed for ${ref}.` };
    case 'PACKED':
      return { title: 'Your order is packed', body: `${ref} is packed and ready for the rider.` };
    case 'SHIPPED':
      return { title: `${ref} is on its way`, body: extra?.rider ? `Rider ${extra.rider}. Track it live.` : 'Track it live.' };
    case 'DELIVERED':
      return { title: 'Delivered. How was it?', body: `${ref} was delivered. Tell us how it went.` };
    case 'PAYMENT_FAILED':
      return { title: "Payment didn't go through", body: `Your payment for ${ref} failed. Try again or use another method.` };
    case 'TRANSFER_REJECTED':
      return { title: "We couldn't confirm your transfer", body: extra?.reason ? `${extra.reason}. Upload a new receipt.` : 'Upload a new receipt.' };
    case 'CANCELLED':
      return { title: 'Order cancelled', body: `${ref} was cancelled.` };
    case 'REFUNDED':
      return { title: 'Your refund has been sent', body: `The refund for ${ref} is on its way to you.` };
    default:
      return null; // AWAITING_PAYMENT: a reminder is sent later by a scheduled job
  }
}
