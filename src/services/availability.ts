import { prisma } from '../db';

// How many of each variant are reserved by people who are checking out right now.
export async function heldByVariant(variantIds: string[]): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await prisma.stockHold.groupBy({
    by: ['variantId'],
    where: { variantId: { in: variantIds }, releasedAt: null, expiresAt: { gt: new Date() } },
    _sum: { qty: true },
  });
  return new Map(rows.map((r) => [r.variantId, r._sum.qty ?? 0]));
}
