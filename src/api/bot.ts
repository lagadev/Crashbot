import { Hono } from "hono";
import type { Env } from "../env";
import { TelegramBotApi } from "../utils/telegram";
import { ok } from "../utils/response";
import { creditDeposit } from "./deposits";
import { upsertUser } from "./auth";
import { createTkInvoice } from "./uglypay";
import { buildMainKeyboard } from "../utils/keyboard";

export const botApi = new Hono<{ Bindings: Env }>();

const WITHDRAW_PROMPT_MARKER = "Enter withdrawal amount";
const CUR = "\u09f3"; // ৳ - this bot's currency is BDT only

botApi.post("/webhook", async (c) => {
  const update: any = await c.req.json().catch(() => null);
  if (!update) return ok({});

  const bot = new TelegramBotApi(c.env.BOT_TOKEN);
  const host = c.req.header("host") || "";

  try {
    // 1) Telegram always requires an immediate OK to pre_checkout_query.
    if (update.pre_checkout_query) {
      await bot.answerPreCheckoutQuery(update.pre_checkout_query.id, true);
      return ok({});
    }

    // 2) Inline button taps (deposit flow, copy link, back).
    if (update.callback_query) {
      await handleCallback(c.env, bot, update.callback_query, host);
      return ok({});
    }

    const msg = update.message;
    if (!msg) return ok({});

    const userId: number = msg.from.id;
    const chatId: number = msg.chat.id;

    // 3) Successful Stars payment (still available via the Mini App's own
    // Wallet tab; this keeps it working if paid that way too).
    const sp = msg.successful_payment;
    if (sp) {
      const stars = Number(sp.total_amount);
      const chargeId = sp.telegram_payment_charge_id as string;
      const already = await c.env.DB.prepare(`SELECT id FROM deposits WHERE telegram_charge_id = ?`)
        .bind(chargeId)
        .first();
      if (!already) {
        await c.env.DB.prepare(`INSERT INTO deposits (user_id, amount, telegram_charge_id) VALUES (?, ?, ?)`)
          .bind(userId, stars, chargeId)
          .run();
        await c.env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'deposit', ?, ?)`)
          .bind(userId, stars, JSON.stringify({ chargeId }))
          .run();
        await creditDeposit(c.env, userId, stars, bot, "Telegram Stars");
      }
      return ok({});
    }

    const text: string = msg.text || "";

    // 4) /start (optionally with a referral deep-link payload).
    if (text.startsWith("/start")) {
      const startParam = text.split(" ")[1] || "";
      await upsertUser(
        c.env,
        { id: userId, username: msg.from.username, first_name: msg.from.first_name || "" },
        startParam
      );
      await sendWelcome(c.env, bot, chatId, userId, host);
      return ok({});
    }

    // 5) A reply to our "Enter withdrawal amount" prompt - recognized purely
    // by what message it's replying to, so no session storage is needed.
    if (msg.reply_to_message?.text?.includes(WITHDRAW_PROMPT_MARKER)) {
      await handleWithdrawAmount(c.env, bot, chatId, userId, text);
      return ok({});
    }

    switch (text) {
      case "\ud83d\udc64 Profile":
        await sendProfile(c.env, bot, chatId, userId);
        break;
      case "\ud83e\udd1d Refer":
        await sendReferral(c.env, bot, chatId, userId);
        break;
      case "\ud83d\udcb0 Withdraw":
        await sendWithdrawPrompt(c.env, bot, chatId, userId);
        break;
      default:
        await bot.sendMessage(chatId, "Use the buttons below \ud83d\udc47", {
          reply_markup: buildMainKeyboard(c.env, userId, host),
        });
    }
  } catch (e: any) {
    console.error("bot webhook error", e);
  }

  return ok({});
});

async function sendWelcome(env: Env, bot: TelegramBotApi, chatId: number, userId: number, host: string) {
  const settingsRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'start_message'`).first<{
    value: string;
  }>();
  const custom = settingsRow?.value ? JSON.parse(settingsRow.value) : null;

  const caption = custom?.text || "\ud83d\ude80 Welcome to <b>Crash Game</b>! Use the buttons below to get started.";
  const keyboard = buildMainKeyboard(env, userId, host);

  if (custom?.imageUrl) {
    await bot.sendPhotoBroadcast(chatId, custom.imageUrl, caption, keyboard);
  } else {
    await bot.sendMessage(chatId, caption, { reply_markup: keyboard });
  }
}

async function sendProfile(env: Env, bot: TelegramBotApi, chatId: number, userId: number) {
  const user = await env.DB.prepare(
    `SELECT balance, total_wagered, total_deposited, total_withdrawn, invited_count, referral_earned
     FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{
      balance: number;
      total_wagered: number;
      total_deposited: number;
      total_withdrawn: number;
      invited_count: number;
      referral_earned: number;
    }>();

  if (!user) {
    await bot.sendMessage(chatId, "Tap /start first to set up your account.");
    return;
  }

  const text = [
    `Balance: ${CUR}${user.balance}`,
    ``,
    `\ud83d\udcca <b>Stats</b>`,
    `Wagered: ${CUR}${user.total_wagered}`,
    `Deposits: ${CUR}${user.total_deposited}`,
    `Withdrawals: ${CUR}${user.total_withdrawn}`,
    `Total Referred: ${user.invited_count}`,
    `Referral Earned: ${CUR}${user.referral_earned}`,
  ].join("\n");

  await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "\ud83d\udcb3 Deposit", callback_data: "dep:amounts" }]] },
  });
}

async function sendReferral(env: Env, bot: TelegramBotApi, chatId: number, userId: number) {
  const [user, settingsRows] = await Promise.all([
    env.DB.prepare(`SELECT invited_count, referral_earned, referral_pending FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ invited_count: number; referral_earned: number; referral_pending: number }>(),
    env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN ('referral_deposit_bonus_percent', 'referral_flat_bonus', 'referral_daily_cap')`
    ).all<{ key: string; value: string }>(),
  ]);
  const s = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));
  const link = `https://t.me/${env.BOT_USERNAME}${env.APP_SHORT_NAME ? "/" + env.APP_SHORT_NAME : ""}?startapp=ref_${userId}`;

  const text = [
    `Invite friends and earn <b>${s.referral_deposit_bonus_percent ?? 10}%</b> from their deposits!`,
    `Also by \ud83c\udfab ${CUR}${s.referral_flat_bonus ?? 5} for each, but no more than ${s.referral_daily_cap ?? 30} per day`,
    ``,
    `Invited: ${user?.invited_count ?? 0}`,
    `Earned: ${CUR}${user?.referral_earned ?? 0}`,
    `Pending: ${CUR}${user?.referral_pending ?? 0}`,
    ``,
    `<code>${link}</code>`,
  ].join("\n");

  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
    "Join me on Crash Game and grab your bonus!"
  )}`;

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "\ud83d\udccb Copy Link", callback_data: `copy:${userId}` },
          { text: "\ud83d\udce4 Share Link", url: shareUrl },
        ],
      ],
    },
  });
}

async function sendWithdrawPrompt(env: Env, bot: TelegramBotApi, chatId: number, userId: number) {
  const [user, feeRow] = await Promise.all([
    env.DB.prepare(`SELECT balance FROM users WHERE id = ?`).bind(userId).first<{ balance: number }>(),
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'withdraw_fee_percent'`).first<{ value: string }>(),
  ]);
  const balance = user?.balance ?? 0;
  const feePercent = Number(feeRow?.value ?? "0");
  const min = Number(env.MIN_WITHDRAW_STARS || "50");
  const availableAfterFee = Math.floor(balance * (1 - feePercent / 100));

  const text = [
    `${CUR} ${WITHDRAW_PROMPT_MARKER}`,
    ``,
    `- Balance: ${CUR}${balance}`,
    `- Fee: ${feePercent}%`,
    `- Minimum withdrawal: ${CUR}${min}`,
    `Available for withdrawal: ${CUR}${availableAfterFee}`,
  ].join("\n");

  await bot.sendMessage(chatId, text, { reply_markup: { force_reply: true, input_field_placeholder: "e.g. 100" } });
  await bot.sendMessage(chatId, "Reply with an amount above, or tap Back to cancel.", {
    reply_markup: { inline_keyboard: [[{ text: "\ud83d\udd19 Back", callback_data: "back" }]] },
  });
}

async function handleWithdrawAmount(env: Env, bot: TelegramBotApi, chatId: number, userId: number, text: string) {
  const amount = Number(text.trim());
  const min = Number(env.MIN_WITHDRAW_STARS || "50");
  if (!Number.isInteger(amount) || amount < min) {
    await bot.sendMessage(chatId, `Please reply with a whole number of at least ${CUR}${min}.`);
    return;
  }

  const [user, feeRow] = await Promise.all([
    env.DB.prepare(`SELECT balance FROM users WHERE id = ?`).bind(userId).first<{ balance: number }>(),
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'withdraw_fee_percent'`).first<{ value: string }>(),
  ]);
  if (!user || user.balance < amount) {
    await bot.sendMessage(chatId, "\u274c Insufficient balance.");
    return;
  }

  const feePercent = Number(feeRow?.value ?? "0");
  const netAmount = Math.floor(amount * (1 - feePercent / 100));

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET balance = balance - ? WHERE id = ?`).bind(amount, userId),
    env.DB.prepare(
      `INSERT INTO withdraw_requests (user_id, amount, fee_percent, net_amount) VALUES (?, ?, ?, ?)`
    ).bind(userId, amount, feePercent, netAmount),
    env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, meta) VALUES (?, 'withdraw', ?, ?)`).bind(
      userId,
      -amount,
      JSON.stringify({ status: "pending", feePercent, netAmount })
    ),
  ]);

  await bot.sendMessage(
    chatId,
    `\u2705 Withdrawal request submitted for ${CUR}${amount} (fee ${feePercent}%). You'll receive ${CUR}${netAmount} once approved.`
  );
}

async function handleCallback(env: Env, bot: TelegramBotApi, cq: any, host: string) {
  const userId: number = cq.from.id;
  const chatId: number = cq.message.chat.id;
  const data: string = cq.data || "";

  if (data === "back") {
    await bot.answerCallbackQuery(cq.id);
    await bot.sendMessage(chatId, "Cancelled.", { reply_markup: buildMainKeyboard(env, userId, host) });
    return;
  }

  if (data.startsWith("copy:")) {
    const link = `https://t.me/${env.BOT_USERNAME}${env.APP_SHORT_NAME ? "/" + env.APP_SHORT_NAME : ""}?startapp=ref_${userId}`;
    await bot.answerCallbackQuery(cq.id, "Link shown below \u2b07\ufe0f");
    await bot.sendMessage(chatId, `<code>${link}</code>`, { parse_mode: "HTML" });
    return;
  }

  if (data === "dep:amounts") {
    await bot.answerCallbackQuery(cq.id);
    await bot.sendMessage(chatId, `Choose an amount (${CUR}):`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `${CUR}100`, callback_data: "dep:tk:100" },
            { text: `${CUR}500`, callback_data: "dep:tk:500" },
            { text: `${CUR}1000`, callback_data: "dep:tk:1000" },
          ],
        ],
      },
    });
    return;
  }

  const m = data.match(/^dep:tk:(\d+)$/);
  if (m) {
    const amount = Number(m[1]);
    await bot.answerCallbackQuery(cq.id, "Creating your invoice\u2026");
    try {
      const res = await createTkInvoice(env, userId, amount);
      await bot.sendMessage(chatId, `Tap below to pay ${CUR}${res.amountTk}.`, {
        reply_markup: { inline_keyboard: [[{ text: "Pay Now", url: res.payUrl }]] },
      });
    } catch (e: any) {
      await bot.sendMessage(chatId, `\u274c ${e.message}`);
    }
  }
}
