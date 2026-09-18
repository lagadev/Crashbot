# Crash Game Bot — fully independent project

A complete, standalone Crash game: its own Mini App, its own Durable-Object
game engine, its own Admin Panel, its own D1 database — **no connection to
any other project.** On top of that base, it adds a classic Telegram bot
experience: a persistent reply keyboard for Play / Profile / Refer /
Withdraw / (admin) Admin Panel, driven through chat.

This is a fork of the original crash-game codebase, extended with the
keyboard-driven bot layer built directly into the same Worker (no
cross-project API calls, no shared secrets between projects - it's all one
deployable unit with one database).

**Currency is BDT (৳) only** for the bot's Profile/Refer/Withdraw/Deposit
flow — deposits go through a BDT payment gateway and every amount is shown
in Taka. (Telegram Stars and TON/GRAM deposits are also still available
from the Mini App's own Wallet screen, if you want them.)

## The keyboard

```
[ 🎮 Play Crash ]                      <- web_app, opens this Worker's own
                                           Mini App at ?view=crash (Crash
                                           screen only, no tab bar)
[ 👤 Profile ] [ 🤝 Refer ]            <- plain text buttons, handled in chat
[ 💰 Withdraw ]
[ 🛠 Admin Panel ]                     <- web_app, admins only (ADMIN_TELEGRAM_IDS)
```

- **Profile** → balance, wagered/deposited/withdrawn, referral totals, plus
  an inline **Deposit** button.
- **Refer** → bonus %, flat per-invite bonus + daily cap (from Admin Panel →
  Settings), invited/earned/pending, the `?startapp=ref_<id>` link as
  tap-to-copy monospace text, plus inline **Copy Link** / **Share Link**.
- **Withdraw** → balance, fee %, minimum, "available after fee"; reply with
  a number to submit (uses Telegram's `force_reply` - no session storage
  needed, the bot recognizes the reply by what message it's answering), or
  **Back** to cancel.
- **Deposit** (from Profile) → pick a ৳ amount → creates an invoice via your
  BDT gateway → sends a **Pay Now** link. Configure the gateway from Admin
  Panel → Settings, same as the underlying Crash game project.

Everything else (the actual Crash game mechanics, the Mini App's Task/Refer/
Profile tabs, the full Admin Panel with dashboard/users/withdrawals/tasks/
game tuning/bot & broadcast) is the same proven crash-game codebase - see
its own in-app "About"/code comments for the deep details on provably-fair
rounds, the referral/turnover system, TonConnect deposits, etc.

## Setup

### 1. Create your bot & Mini App
1. Create a bot with **@BotFather**, grab the token.
2. Attach a Mini App pointing at this Worker's URL (once deployed).

### 2. Install & configure

```bash
npm install
npx wrangler login

npx wrangler d1 create crash_bot_db     # a brand new, independent database
npm run db:migrate:remote               # applies all migrations

npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_KEY       # your Admin Panel password
npx wrangler secret put UGLYPAY_API_KEY # your BDT gateway API key
```

Edit `wrangler.toml`: `database_id` (from the `d1 create` output),
`BOT_USERNAME`, `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user ids that
should see the Admin Panel keyboard button).

### 3. Deploy

```bash
npm run deploy
```

### 4. Point the bot's webhook here

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<this-worker>.workers.dev/telegram/webhook"
```

### 5. Configure the BDT gateway, bonuses, and game tuning

Open `https://<this-worker>.workers.dev/admin/`, sign in with your
`ADMIN_KEY`, and set from **Settings**: joining bonus, first-deposit bonus,
referral rewards, withdrawal fee, and the BDT gateway's base URL / callback
URL / rate.

That's it — `/start` in the bot now shows the full keyboard, and the Mini
App works normally for anyone who opens it directly too.

## Local development

```bash
npm run dev
```

Telegram's `initData` verification needs a real Telegram WebView, so test
the Mini App via Telegram's preview; the bot's chat commands and the Admin
Panel both work fully against `wrangler dev` locally.
