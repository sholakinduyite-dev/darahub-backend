import type { NotificationPref, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../db';

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

// Sends the phone notification. For now it only logs. Once your Firebase project is ready, replace the body
// with firebase-admin's messaging().sendEachForMulticast(...) using the user's DeviceToken rows.
async function pushToUser(userId: string, message: { title: string; body: string; deepLink?: string; notificationId: string }) {
  const tokens = await prisma.deviceToken.findMany({ where: { userId } });
  if (tokens.length === 0) return;
  console.log(`[PUSH] to ${tokens.length} device(s) of user ${userId}: ${message.title}`);
}
