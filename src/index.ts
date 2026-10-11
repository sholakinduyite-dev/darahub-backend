import { app } from './app';
import { config } from './config';
import { prisma } from './db';

if (config.devShowCodes && config.isProd) {
  console.warn('WARNING: DEV_SHOW_CODES is on in production. One-time codes are being returned to the app. Turn it off before real customers sign up.');
}
if (config.messagingMode === 'console') {
  console.warn('Messaging is in console mode: verification codes are printed in this log and NOT sent to people. See src/lib/messenger.ts.');
}

const server = app.listen(config.port, () => {
  console.log(`Dara's Hub API is running on port ${config.port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
