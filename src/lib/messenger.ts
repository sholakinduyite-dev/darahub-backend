import { config } from '../config';

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  return `${name.slice(0, 1)}***@${domain}`;
}

// Sends a one-time code by email.
// In "console" mode (the default) the code is printed in the server log: good for testing, useless for real customers.
// To go live: configure an email provider, add its key, and set MESSAGING_MODE=live.
export async function sendCode(input: { channel: 'EMAIL'; to: string; code: string; minutes: number }): Promise<void> {
  const text = `Your Dara's Hub code is ${input.code}. It expires in ${input.minutes} minutes. Don't share it with anyone.`;

  if (config.messagingMode === 'console') {
    console.log(`[CODE:EMAIL] to ${input.to}: ${text}`);
    return;
  }

  // TODO: call the configured email provider here, using EMAIL_PROVIDER_API_KEY and EMAIL_FROM.
  throw new Error('Email provider not connected yet. See src/lib/messenger.ts');
}
