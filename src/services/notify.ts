import type { NotificationPref, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { firebaseMessaging } from '../lib/firebase';

const CATEGORY: Record<NotificationType, keyof NotificationPref | null> = {
  ORDER: 'orders',
  PROMO: 'promos',
  REWARD: 'rewards',
  REPLY: 'replies',
  SUPPORT: 'support',
  ADMIN_ALERT: null,
};

// Quiet hours apply to promotions only. Order updates are never paused. Times are Nigeria time (UTC+1).
function inQuietHours(pref: NotificationPref, now: Date): boolean {
  if (!pref.quietStart || !pref.quietEnd) return false;
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const current = (now.getUTCHours() * 60 + now.getUTCMinutes() + 60) % 1440;
  const start = toMinutes(pref.quietStart);
  const end = toMinutes(pref.quietEnd);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export async function notifyUser(input: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string;
  data?: Prisma.InputJsonValue;
}) {
  // The in-app inbox always gets the message.
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      data: input.data,
    },
  });

  const pref = await prisma.notificationPref.findUnique({ where: { userId: input.userId } });
  if (pref) {
    if (!pref.push) return notification;
    const category = CATEGORY[input.type];
    if (category && pref[category] === false) return notification;
    if (input.type === 'PROMO' && inQuietHours(pref, new Date())) return notification;
  }

  await pushToUser(input.userId, { title: input.title, body: input.body, deepLink: input.deepLink, notificationId: notification.id });
  return notification;
}

async function pushToUser(userId: string, message: { title: string; body: string; deepLink?: string; notificationId: string }) {
  const tokens = await prisma.deviceToken.findMany({ where: { userId } });
  if (tokens.length === 0) return;

  const messaging = firebaseMessaging();
  if (!messaging) {
    console.warn('[PUSH] Firebase is not configured; notification kept in inbox only.');
    return;
  }

  try {
    const result = await messaging.sendEachForMulticast({
      tokens: tokens.map((item) => item.token),
      notification: { title: message.title, body: message.body },
      data: {
        notificationId: message.notificationId,
        deepLink: message.deepLink ?? '',
      },
    });

    const invalidTokens = result.responses
      .map((response, index) => ({ response, token: tokens[index].token }))
      .filter(({ response }) => !response.success)
      .filter(({ response }) => {
        const code = response.error?.code ?? '';
        return code.includes('registration-token-not-registered') || code.includes('invalid-registration-token');
      })
      .map(({ token }) => token);

    if (invalidTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
    }
  } catch (error) {
    console.error('[PUSH] Firebase delivery failed:', error instanceof Error ? error.message : error);
  }
}
