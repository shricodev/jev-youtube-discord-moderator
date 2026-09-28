// Twitch chat moderator that uses TypeSafe's Jev (no LLM in the loop) to judge every message,
// and the Twitch Helix API to delete the negative ones. Jev is reached through Composio by
// default, or through OpenRouter with JEV_PROVIDER=openrouter (see lib/jev.mjs).
// Messages arrive through EventSub over WebSocket (pushed, no polling).
//
//   npm run twitch:auth -- bot        # log in as your channel (account A)
//   npm run twitch:auth -- flooder    # log in as the throwaway viewer (account B)
//   npm run twitch:bot                # run the moderator
//   npm run twitch:flood -- 60        # flood the channel with 60 messages as account B
//
// Requires Node 22+ (built-in fetch and WebSocket).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJudge } from './lib/jev.mjs';
import { HOSTILE, NORMAL, pick } from './lib/pools.mjs';
import {
  createSemaphore, createStats, floodCount, fmt, main, num, onShutdown, quote, requireEnv, sleep, thresholds,
} from './lib/util.mjs';

const HELIX = 'https://api.twitch.tv/helix';
// Override only for local testing, e.g. with the Twitch CLI: twitch event websocket start-server
const EVENTSUB_URL = process.env.TWITCH_EVENTSUB_URL || 'wss://eventsub.wss.twitch.tv/ws';
const TOKENS_FILE = fileURLToPath(new URL('./.twitch-tokens.json', import.meta.url));
const SCOPES = {
  bot: 'user:read:chat moderator:manage:chat_messages',
  flooder: 'user:write:chat',
};

const env = process.env;

// The flooder appends a " (n)" counter so Twitch's duplicate filter doesn't drop repeats.
// The bot strips it again before judging and scoring.
const HOSTILE_SET = new Set(HOSTILE);
const NORMAL_SET = new Set(NORMAL);
const stripCounter = (s) => s.replace(/\s\(\d+\)$/, '');

// ─────────────────────────────────────────────────────────────────────────────
// Twitch auth: Device Code Grant (public client, no redirect server needed).
// Tokens live in .twitch-tokens.json (gitignored) and refresh automatically.
// ─────────────────────────────────────────────────────────────────────────────
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`${TOKENS_FILE} is corrupt (${e.message}). Delete it and run: npm run twitch:auth -- bot`);
  }
}
// Merges into the file on disk because the bot and flooder are separate processes that each
// rotate their own refresh token. Write-then-rename keeps it atomic.
function saveToken(role, data) {
  const all = loadTokens();
  all[role] = { ...all[role], ...data };
  const tmp = `${TOKENS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(tmp, TOKENS_FILE);
}
function getToken(role) {
  const t = loadTokens()[role];
  if (!t?.access_token) throw new Error(`No ${role} token. Run: npm run twitch:auth -- ${role}`);
  return t;
}

async function auth(role) {
  if (!SCOPES[role]) throw new Error('Usage: npm run twitch:auth -- <bot|flooder>');
  const form = (o) => ({ method: 'POST', body: new URLSearchParams(o) });

  const dev = await (await fetch('https://id.twitch.tv/oauth2/device',
    form({ client_id: env.TWITCH_CLIENT_ID, scopes: SCOPES[role] }))).json();
  if (!dev.device_code) {
    throw new Error(`Device code request failed: ${JSON.stringify(dev)}. Is the Twitch app's Client Type set to "Public"?`);
  }

  console.log(`\nLog in as the ${role === 'bot' ? 'CHANNEL OWNER or a MODERATOR (account A)' : 'THROWAWAY VIEWER (account B)'}:`);
  console.log(`  1. Open ${dev.verification_uri}`);
  console.log(`  2. Confirm the code ${dev.user_code} and click Authorize\n`);
  console.log('Waiting for you to authorize...');

  let interval = (dev.interval ?? 5) * 1000;
  const deadline = Date.now() + dev.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch('https://id.twitch.tv/oauth2/token', form({
      client_id: env.TWITCH_CLIENT_ID,
      scopes: SCOPES[role],
      device_code: dev.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }));
    const body = await res.json();
    if (res.ok) {
      const who = await validate(body.access_token);
      saveToken(role, {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        user_id: who.user_id,
        login: who.login,
      });
      console.log(`✅ Saved ${role} token for @${who.login} (id ${who.user_id}).`);
      return;
    }
    if (body.message === 'slow_down') interval += 5000;
    else if (body.message !== 'authorization_pending') throw new Error(`Auth failed: ${JSON.stringify(body)}`);
  }
  throw new Error('Device code expired. Run the auth command again.');
}

async function validate(accessToken) {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Token validation failed: HTTP ${res.status}`);
  return res.json();
}

// Refresh tokens are single-use, so concurrent 401s must share one refresh.
const refreshing = {};
function refresh(role) {
  return (refreshing[role] ??= (async () => {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: getToken(role).refresh_token,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Token refresh failed (${role}): ${JSON.stringify(body)}. Run: npm run twitch:auth -- ${role}`);
    }
    saveToken(role, { access_token: body.access_token, refresh_token: body.refresh_token });
  })().finally(() => delete refreshing[role]));
}

// Helix call as a given role; refreshes once on 401 and waits out 429s. Returns { status, body }.
async function helix(role, method, path, json) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HELIX}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken(role).access_token}`,
        'Client-Id': env.TWITCH_CLIENT_ID,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 && attempt === 0) { await refresh(role); continue; }
    if (res.status === 429 && attempt < 5) {
      const reset = Number(res.headers.get('ratelimit-reset')) * 1000;
      await sleep(Math.min(60000, Math.max(250, (reset || 0) - Date.now())));
      continue;
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 200) };
    }
    return { status: res.status, body };
  }
}

// The channel to moderate: TWITCH_CHANNEL if set (bot must be a mod there), else the bot's own channel.
async function resolveBroadcaster(role) {
  const channel = env.TWITCH_CHANNEL?.trim().replace(/^#/, '').toLowerCase();
  if (!channel) return { id: getToken('bot').user_id, login: getToken('bot').login };
  const r = await helix(role, 'GET', `/users?login=${encodeURIComponent(channel)}`);
  const user = r.body?.data?.[0];
  if (!user) throw new Error(`Twitch channel "${channel}" not found (HTTP ${r.status})`);
  return { id: user.id, login: user.login };
}

// ─────────────────────────────────────────────────────────────────────────────
// Moderator bot
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
  const { DELETE_AT, REVIEW_AT } = thresholds();
  const sem = createSemaphore(num('MAX_IN_FLIGHT', 16, { min: 1, int: true }));
  const { judge, label } = createJudge();
  const stats = createStats(label);

  const me = getToken('bot');
  await validate(me.access_token).catch(() => refresh('bot'));
  const broadcaster = await resolveBroadcaster('bot');

  // Twitch has no bulk delete: one DELETE per message.
  async function deleteMessage(ev, rec) {
    const t0 = performance.now();
    const r = await helix('bot', 'DELETE',
      `/moderation/chat?broadcaster_id=${broadcaster.id}&moderator_id=${me.user_id}&message_id=${ev.message_id}`);
    const done = performance.now();
    if (r.status === 404) return; // already deleted by someone else
    if (r.status !== 204) {
      stats.errors++;
      const hint = r.status === 403
        ? ` (is @${me.login} a moderator in #${broadcaster.login}?)`
        : r.status === 400 ? ' (messages from mods, the broadcaster, or older than 6 hours can\'t be deleted)' : '';
      console.error(`delete failed: HTTP ${r.status} ${r.body?.message ?? ''}${hint}  ${quote(ev.message.text)}`);
      return;
    }
    rec.deleteMs = done - t0;
    rec.totalMs = done - rec.recvAt;
    stats.deleted++;
    stats.sample('deleteMs', rec.deleteMs);
    stats.sample('totalMs', rec.totalMs);
    stats.sample('visibleMs', Date.now() - rec.sentAt);
    console.log(
      `🗑️  DELETE  jev ${fmt(rec.jevMs)}  delete ${fmt(rec.deleteMs)}  total ${fmt(rec.totalMs)}` +
        `  p=${rec.p.toFixed(2)} ${rec.category.padEnd(10)} ${quote(ev.message.text)}`
    );
  }

  // Twitch won't let anyone delete messages from the broadcaster or moderators, so don't judge them.
  const PROTECTED_BADGES = new Set(['broadcaster', 'moderator', 'staff', 'admin', 'global_mod']);

  async function onChatMessage(ev, sentAt) {
    if (ev.chatter_user_id === me.user_id || ev.chatter_user_id === broadcaster.id) return;
    if (ev.badges?.some((b) => PROTECTED_BADGES.has(b.set_id))) return;
    const text = ev.message?.text;
    if (!text) return;

    const rec = { recvAt: performance.now(), sentAt };
    stats.seen++;

    const clean = stripCounter(text);
    await sem.acquire();
    let v;
    try {
      v = await judge(clean);
    } catch (e) {
      stats.errors++;
      console.error(`jev error: ${e.message}  ${quote(text)}`);
      return;
    } finally {
      sem.release();
    }

    Object.assign(rec, { jevMs: v.ms, p: v.p, category: v.category });
    stats.sample('jevMs', v.ms);
    stats.tokens += v.tokens;

    const flagged = v.p >= DELETE_AT;
    stats.score(HOSTILE_SET.has(clean) ? true : NORMAL_SET.has(clean) ? false : null, flagged);

    if (flagged) {
      await deleteMessage(ev, rec);
    } else if (v.p >= REVIEW_AT) {
      stats.review++;
      console.log(`🟡 REVIEW  jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(text)}`);
    } else {
      stats.kept++;
      console.log(`✅ keep    jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(text)}`);
    }

    if (stats.seen % 25 === 0) stats.print();
  }

  let ws;
  let watchdog;
  let keepaliveMs = 15000;
  let shuttingDown = false;
  let subscribedOnce = false;
  let failures = 0; // consecutive failed connections, for backoff

  function reconnectLater(reason) {
    if (shuttingDown) return;
    clearTimeout(watchdog);
    const delay = Math.min(30000, 1000 * 2 ** failures++);
    console.warn(`⚠️  ${reason}, reconnecting in ${Math.round(delay / 1000)}s...`);
    setTimeout(() => connect(), delay);
  }

  async function subscribe(sessionId) {
    const r = await helix('bot', 'POST', '/eventsub/subscriptions', {
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: broadcaster.id, user_id: me.user_id },
      transport: { method: 'websocket', session_id: sessionId },
    });
    if (r.status === 202) return;
    const detail = `HTTP ${r.status} ${r.body?.message ?? JSON.stringify(r.body)}`;
    // A 4xx on the first try is a setup problem (scopes, wrong channel); retrying won't fix it.
    if (!subscribedOnce && r.status >= 400 && r.status < 500) {
      throw new Error(`EventSub subscribe failed: ${detail}. Re-run: npm run twitch:auth -- bot`);
    }
    throw Object.assign(new Error(`EventSub subscribe failed: ${detail}`), { retry: true });
  }

  function connect(url = EVENTSUB_URL, isReconnect = false) {
    const sock = new WebSocket(url);
    const armWatchdog = () => {
      clearTimeout(watchdog);
      // No message, not even a keepalive, means the connection is dead.
      watchdog = setTimeout(() => {
        sock.retired = true;
        sock.close();
        reconnectLater('EventSub went quiet');
      }, keepaliveMs + 5000);
    };

    sock.onmessage = async ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return console.warn('⚠️  Ignoring a non-JSON EventSub frame');
      }
      const type = msg.metadata?.message_type;
      if (sock === ws || type === 'session_welcome') armWatchdog();

      if (type === 'session_welcome') {
        const old = ws;
        ws = sock;
        sock.welcomed = true;
        keepaliveMs = (msg.payload.session.keepalive_timeout_seconds ?? 10) * 1000;
        armWatchdog();
        if (old && old !== sock) {
          old.retired = true;
          old.close();
        }
        if (isReconnect) {
          failures = 0;
          console.log('Reconnected to EventSub.'); // subscriptions carry over to the new session
          return;
        }
        // Must subscribe within 10 s of the welcome.
        try {
          await subscribe(msg.payload.session.id);
        } catch (e) {
          if (!e.retry && !subscribedOnce) {
            console.error(`❌ ${e.message}`);
            process.exit(1);
          }
          sock.retired = true;
          sock.close();
          return reconnectLater(e.message);
        }
        failures = 0;
        if (subscribedOnce) {
          console.log('Reconnected to EventSub and re-subscribed.');
          return;
        }
        subscribedOnce = true;
        console.log(`Connected to EventSub as @${me.login}, moderating #${broadcaster.login}. Jev via ${label}.`);
        console.log(`Delete at p ≥ ${DELETE_AT}, review at p ≥ ${REVIEW_AT}. Ctrl+C prints the final summary.\n`);
      } else if (type === 'session_reconnect') {
        connect(msg.payload.session.reconnect_url, true);
      } else if (type === 'notification' && msg.metadata.subscription_type === 'channel.chat.message') {
        onChatMessage(msg.payload.event, Date.parse(msg.metadata.message_timestamp)).catch((e) => {
          stats.errors++;
          console.error(`message handler error: ${e.message}`);
        });
      } else if (type === 'revocation') {
        // Usually means the bot lost mod status or the app was revoked.
        console.error(`❌ EventSub subscription revoked (${msg.payload.subscription.status}). Fix access and re-run: npm run twitch:auth -- bot`);
        stats.print();
        process.exit(1);
      }
    };
    sock.onclose = (e) => {
      if (sock.retired || shuttingDown) return;
      // A failed session_reconnect target: the old socket is still live, and its close will handle it.
      if (isReconnect && !sock.welcomed) return;
      // A socket that was already replaced by a newer session.
      if (sock.welcomed && sock !== ws) return;
      reconnectLater(`EventSub closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
    };
    sock.onerror = () => {}; // onclose handles it
  }

  onShutdown(() => {
    shuttingDown = true;
    stats.print();
    clearTimeout(watchdog);
    ws?.close();
  });

  connect();
}

// ─────────────────────────────────────────────────────────────────────────────
// Flooder: posts a mix of hostile and normal messages as account B.
// Regular users can send ~20 messages per 30 s, so sends are paced.
// ─────────────────────────────────────────────────────────────────────────────
async function flood(count) {
  const sender = getToken('flooder');
  const broadcaster = await resolveBroadcaster('flooder');
  if (sender.user_id === broadcaster.id) {
    throw new Error('The flooder must be a different account from the channel owner (Twitch won\'t delete broadcaster messages).');
  }
  const ratio = num('FLOOD_TOXIC_RATIO', 0.5, { min: 0, max: 1 });
  const gap = num('FLOOD_INTERVAL_MS', 1600, { min: 0 });

  const t0 = Date.now();
  let hostile = 0;
  let dropped = 0;
  for (let i = 1; i <= count; i++) {
    const m = pick(ratio);
    const r = await helix('flooder', 'POST', '/chat/messages', {
      broadcaster_id: broadcaster.id,
      sender_id: sender.user_id,
      message: `${m.text} (${i})`,
    });
    const sent = r.status === 200 && r.body?.data?.[0]?.is_sent;
    if (sent) {
      if (m.hostile) hostile++;
    } else {
      dropped++;
      const why = r.body?.data?.[0]?.drop_reason?.message ?? r.body?.message ?? `HTTP ${r.status}`;
      console.log(`\n⚠️  message ${i} not sent: ${why}`);
    }
    process.stdout.write(`\rsent ${i - dropped}/${count}${dropped ? ` (${dropped} dropped)` : ''}`);
    if (i < count) await sleep(gap);
  }
  console.log(
    `\nDone: ${count - dropped} messages (${hostile} hostile) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (dropped ? `, ${dropped} dropped by Twitch` : '')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point. Must stay at the bottom so the consts above are initialized first.
// ─────────────────────────────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'bot';

await main(async () => {
  if (typeof WebSocket === 'undefined') throw new Error(`Node 22+ is required (found ${process.version})`);
  requireEnv('TWITCH_CLIENT_ID');
  if (mode === 'auth') await auth(process.argv[3]);
  else if (mode === 'flood') await flood(floodCount(process.argv[3]));
  else if (mode === 'bot') await runBot();
  else console.log('Usage: node --env-file=.env twitch-mod.mjs [auth <bot|flooder> | bot | flood <count>]');
});
