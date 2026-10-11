import crypto from 'crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { prisma } from './db';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { favoritesRouter } from './routes/favorites';
import { meRouter } from './routes/me';
import { notificationsRouter } from './routes/notifications';
import { cartRouter } from './routes/cart';
import { ordersRouter, paymentWebhookRouter } from './routes/orders';
import { adminRouter, paymentRouter } from './routes/admin';

export const app = express();

app.set('trust proxy', 1); // the host puts a proxy in front of the app
app.use(helmet());
app.use(cors({ origin: config.corsOrigins.length > 0 ? config.corsOrigins : !config.isProd })); // the phone app does not need CORS; the admin website will
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.id = crypto.randomUUID(); // shown to the user as a support code when something breaks
  next();
});

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/auth', authRouter);
app.use('/me', meRouter);
app.use('/notifications', notificationsRouter);
app.use('/favorites', favoritesRouter);
app.use('/cart', cartRouter);
app.use('/orders', ordersRouter);
app.use('/payments/webhooks', paymentWebhookRouter);
app.use('/payments', paymentRouter);
app.use('/admin', adminRouter);
app.use('/', catalogRouter);

app.use(notFoundHandler);
app.use(errorHandler);
