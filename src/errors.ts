// One error format for the whole API, matching the error catalog in the wireframes:
// { "error": { "code": "CODE_INVALID", "message": "Plain words for the user", "details": {...}, "requestId": "..." } }
// The app shows "message". "code" tells the app which screen or pattern to use. "requestId" is for support.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'NOT_VERIFIED'
  | 'EMAIL_TAKEN'
  | 'PHONE_TAKEN'
  | 'USE_GOOGLE_SIGNIN'
  | 'GOOGLE_ACCOUNT_EXISTS'
  | 'GOOGLE_TOKEN_INVALID'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'OUT_OF_STOCK'
  | 'PAYMENT_FAILED'
  | 'SERVER_ERROR';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'} left`;

export const Errors = {
  validation: (fields: Record<string, string>) =>
    new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields.', { fields }),
  invalidCredentials: (triesLeft?: number) =>
    new AppError(
      401,
      'INVALID_CREDENTIALS',
      triesLeft === undefined ? 'Email or password is incorrect.' : `Email or password is incorrect. ${tries(triesLeft)}.`,
      triesLeft === undefined ? undefined : { triesLeft },
    ),
  accountLocked: (retryInSeconds: number) =>
    new AppError(429, 'ACCOUNT_LOCKED', `Too many wrong tries. Try again in ${Math.max(1, Math.ceil(retryInSeconds / 60))} minutes.`, { retryInSeconds }),
  notVerified: (target: string) =>
    new AppError(403, 'NOT_VERIFIED', 'Verify your account to continue. We sent you a new code.', { next: 'verify', purpose: 'signup', target }),
  emailTaken: () =>
    new AppError(409, 'EMAIL_TAKEN', 'An account with this email exists.', { fields: { email: 'An account with this email exists. Try logging in.' } }),
  phoneTaken: () =>
    new AppError(409, 'PHONE_TAKEN', 'An account with this phone number exists.', { fields: { phone: 'An account with this phone number exists.' } }),
  useGoogle: () => new AppError(400, 'USE_GOOGLE_SIGNIN', 'This account uses Google. Tap "Continue with Google".'),
  googleAccountExists: (email: string) =>
    new AppError(409, 'GOOGLE_ACCOUNT_EXISTS', `${email} already has an account. Sign in with your password to link Google.`, { email }),
  googleTokenInvalid: () => new AppError(401, 'GOOGLE_TOKEN_INVALID', "We couldn't sign you in with Google. Try again."),
  codeInvalid: (triesLeft: number) => new AppError(400, 'CODE_INVALID', `That code isn't right. ${tries(triesLeft)}.`, { triesLeft }),
  codeExpired: () => new AppError(400, 'CODE_EXPIRED', 'Your code expired. Send a new one.'),
  tooManyAttempts: () => new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new code.'),
  unauthorized: () => new AppError(401, 'UNAUTHORIZED', 'Please sign in.'),
  sessionExpired: () => new AppError(401, 'SESSION_EXPIRED', 'Please sign in again.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', "You don't have access to this."),
  notFound: () => new AppError(404, 'NOT_FOUND', "We can't find that."),
  conflict: (message = 'That already exists.') => new AppError(409, 'CONFLICT', message),
  rateLimited: (retryInSeconds?: number) =>
    new AppError(429, 'RATE_LIMITED', 'Please wait a moment and try again.', retryInSeconds ? { retryInSeconds } : undefined),
  outOfStock: (available: number) =>
    new AppError(409, 'OUT_OF_STOCK', available > 0 ? `Only ${available} left.` : 'Out of stock.', { available }),
};
