# Dara's Hub backend (v0.1)

The server behind the Dara's Hub mobile app. Built with Node.js, TypeScript, Express and PostgreSQL (through Prisma).

**What works in this version**
- Sign up, email or SMS one-time codes, login, Google sign-in, forgot and reset password, sessions
- Products, categories, search, banners, delivery zones
- Favorites with price-drop detection
- Notification inbox, notification settings, push device registration
- Addresses and profile
- The order status rules and customer messages (ready for the orders module)
- One error format for everything, matching the wireframes' error catalog

**Not built yet** (next modules, in this order): cart and checkout, payments (Paystack, PocketFi, bank transfer approval), orders and the admin API, reviews, rewards, returns, staff roles, broadcasts, real push sending (Firebase), real email and SMS providers.

---

## What you need

1. **Node.js 20 or newer** (or any online coding space that runs Node, such as Replit or GitHub Codespaces).
2. **A PostgreSQL database.** A free one from Neon, Supabase or Render works for testing. Copy its connection string.
3. Two long random secrets. Make each with `openssl rand -hex 32`, or any password generator (32 characters or more).

## Run it (testing)

1. Unzip, open the folder, then copy `.env.example` to a new file named `.env`.
2. Fill in at least these in `.env`:
   - `DATABASE_URL` (your connection string)
   - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (two different random strings)
   - `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` (your owner login)
   - `SEED_DEMO=true` if you want sample products
   - `DEV_SHOW_CODES=true` so codes come back in the API reply while you test
3. In the terminal, run these one at a time:

```
npm install
npm run db:push
npm run db:seed
npm run dev
```

4. Open `http://localhost:3000/health`. You should see `{"ok":true,...}`.

In an online coding space, add the same values in its **Secrets** (or Environment) panel instead of a `.env` file, then run the same four commands.

## Try the sign-up flow

Replace `URL` with your server address. Codes are printed in the server log, and returned as `devCode` if `DEV_SHOW_CODES=true`.

```
curl -X POST URL/auth/register -H "content-type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","phone":"08012345678","password":"password1","acceptedTerms":true}'

curl -X POST URL/auth/verify-code -H "content-type: application/json" \
  -d '{"identifier":"test@example.com","purpose":"signup","code":"123456"}'
```

The second call returns `accessToken` and `refreshToken`. Send the access token as `Authorization: Bearer <token>` on every other call, for example `GET URL/me`.

## Put it online (Render)

1. Put this folder in a GitHub repository.
2. On render.com choose **New > Blueprint** and pick the repository. It reads `render.yaml` and creates the API and a database.
3. In the service's **Environment** settings add: `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`, and the Google client IDs. Never put secrets in the code.
4. After the first deploy, open the service's **Shell** and run `npm run db:seed` once.
5. The free plans are for testing only (they sleep when idle, and free databases can expire). Check Render's current terms and move to a paid plan before real customers use the app.

## Before real customers

- Connect real email and SMS sending in `src/lib/messenger.ts`, then set `MESSAGING_MODE=live`.
- Set `DEV_SHOW_CODES=false`.
- Confirm every value in `src/services/defaultSettings.ts` (hold time, return window and so on). They are starting guesses, not decisions.
- Use real migrations instead of `db:push` once you have real data (`prisma migrate`).

---

## Endpoints

Money is always whole **kobo** (100 kobo = 1 naira). Send the access token in the `Authorization` header where marked.

**Auth** (no token unless marked)
| Method | Path | What it does |
|---|---|---|
| POST | /auth/register | Create account, send code. Body: name, email, phone, password, referralCode?, acceptedTerms |
| POST | /auth/verify-code | Check a code. Body: identifier, purpose (signup, google_phone, reset), code. Returns tokens (or a resetToken for reset) |
| POST | /auth/resend-code | New code. Body: identifier, purpose, channel? (EMAIL or SMS) |
| POST | /auth/login | Body: email, password |
| POST | /auth/google | Body: idToken. Returns status: signed_in, needs_setup or needs_verification |
| POST | /auth/google/complete | New Google users: setupToken, phone, referralCode?, acceptedTerms |
| POST | /auth/link-google | Token required. Body: idToken |
| POST | /auth/forgot-password | Body: identifier, channel? |
| POST | /auth/reset-password | Body: resetToken, newPassword |
| POST | /auth/refresh | Body: refreshToken. Returns new tokens |
| POST | /auth/logout | Body: refreshToken |

**Me** (token required)
| Method | Path | What it does |
|---|---|---|
| GET, PATCH | /me | Profile and unread notification count |
| GET, POST | /me/addresses | List and add addresses |
| PATCH, DELETE | /me/addresses/:id | Edit and delete |
| POST, DELETE | /me/devices | Register and remove a push token |
| GET, PUT | /me/notification-preferences | The notification settings screen |

**Shop** (public)
| Method | Path | What it does |
|---|---|---|
| GET | /categories, /banners, /delivery-zones | Home screen data |
| GET | /products | Search and filters: q, category, sort, minPrice, maxPrice, size, onSale, page, limit |
| GET | /products/:slug | Product details with live availability per size and colour |
| GET | /search/suggest?q= | Suggestions while typing |

**Favorites and notifications** (token required)
| Method | Path | What it does |
|---|---|---|
| GET, POST | /favorites | List (with priceDropped) and add |
| DELETE | /favorites/:productId | Remove |
| GET | /notifications?filter=all, orders, promos, rewards or replies | The inbox |
| GET | /notifications/unread-count | Badge number |
| POST | /notifications/read-all, /notifications/:id/read | Mark as read |

## Errors

Every error looks like this, so the app can show one consistent screen for each:

```
{ "error": { "code": "CODE_INVALID", "message": "That code isn't right. 2 tries left.",
             "details": { "triesLeft": 2 }, "requestId": "..." } }
```

Show `message` to the person. Use `code` to pick the screen (for example `GOOGLE_ACCOUNT_EXISTS` shows the "This email already has an account" screen). Show `requestId` in small text so support can find the problem. For field errors, `details.fields` has one message per field.

## Folder guide

- `prisma/schema.prisma`: the database design
- `prisma/seed.ts`: first-time data (shop rules, categories, owner account, optional demo products)
- `src/routes/`: the endpoints
- `src/lib/`: one-time codes, tokens, sending messages
- `src/services/`: shop rules, notifications, stock availability, order status rules
- `src/errors.ts`: every error code and its plain-language message
