import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}. See .env.example`);
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  // Also used as the key that fingerprints refresh tokens and one-time codes.
  hashSecret: required('JWT_REFRESH_SECRET'),
  supabaseUrl: process.env.SUPABASE_URL,
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL,
  pocketFiBusinessId: process.env.POCKETFI_BUSINESS_ID,
  pocketFiApiKey: process.env.POCKETFI_API_KEY,
  pocketFiWebhookSecret: process.env.POCKETFI_WEBHOOK_SECRET,
  pocketFiCheckoutUrl: process.env.POCKETFI_CHECKOUT_URL,
  pocketFiCallbackUrl: process.env.POCKETFI_CALLBACK_URL,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  googleClientIds: [
    process.env.GOOGLE_CLIENT_ID_ANDROID,
    process.env.GOOGLE_CLIENT_ID_IOS,
    process.env.GOOGLE_CLIENT_ID_WEB,
  ].filter((v): v is string => Boolean(v)),
  // "console" prints codes in the server log instead of sending real email/SMS. Fine for testing only.
  messagingMode: (process.env.MESSAGING_MODE ?? 'console') as 'console' | 'live',
  // TESTING ONLY: returns the one-time code in the API response so you can test without email/SMS. Never use with real customers.
  devShowCodes: process.env.DEV_SHOW_CODES === 'true',
  accessTokenSeconds: 15 * 60,
  refreshTokenDays: 30,
};
