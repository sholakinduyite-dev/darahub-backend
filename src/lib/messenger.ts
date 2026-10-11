import { config } from '../config';

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  return `${name.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  return `***${phone.slice(-4)}`;
}

// Sends a one-time code by email or SMS.
// In "console" mode (the default) the code is printed in the server log: good for testing, useless for real customers.
// To go live: choose an email provider and an SMS provider, add their keys, set MESSAGING_MODE=live,
// and fill in the two "TODO" spots below.
export async function sendCode(input: { channel: 'EMAIL' | 'SMS'; to: string; code: string; minutes: number }): Promise<void> {
  const text = `Your Dara's Hub code is ${input.code}. It expires in ${input.minutes} minutes. Don't share it with anyone.`;

  if (config.messagingMode === 'console') {
    console.log(`[CODE:${input.channel}] to ${input.to}: ${text}`);
    return;
  }

  if (input.channel === 'EMAIL') {
    // TODO: call your email provider here, using EMAIL_PROVIDER_API_KEY and EMAIL_FROM.
    throw new Error('Email provider not connected yet. See src/lib/messenger.ts');
  }
  // TODO: call your SMS provider here, using SMS_PROVIDER_API_KEY and SMS_SENDER_ID.
  throw new Error('SMS provider not connected yet. See src/lib/messenger.ts');
}
