// Discord chat moderator that uses TypeSafe's Jev (no LLM in the loop) to judge every message,
// and discord.js to delete the negative ones. Jev is reached through Composio by default,
// or through OpenRouter with JEV_PROVIDER=openrouter (see lib/jev.mjs).
//
//   npm run bot            # run the moderator
//   npm run flood -- 60    # flood the test channel with 60 messages through a webhook

import { Client, GatewayIntentBits, Events, WebhookClient, RESTJSONErrorCodes } from 'discord.js';
import { createJudge } from './lib/jev.mjs';
import { pick } from './lib/pools.mjs';
import {
  createSemaphore, createStats, floodCount, fmt, main, num, onShutdown, quote, requireEnv, thresholds,
} from './lib/util.mjs';

const env = process.env;
const mode = process.argv[2] ?? 'bot';

await main(async () => {
  if (mode === 'flood') await flood(floodCount(process.argv[3]));
  else if (mode === 'bot') await runBot();
  else console.log('Usage: node --env-file=.env jev-mod.mjs [bot | flood <count>]');
});

// ─────────────────────────────────────────────────────────────────────────────
// Moderator bot
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
  requireEnv('DISCORD_TOKEN');
  const { DELETE_AT, REVIEW_AT } = thresholds();
  const sem = createSemaphore(num('MAX_IN_FLIGHT', 16, { min: 1, int: true }));
  const WATCH = env.WATCH_CHANNEL_ID?.trim() || null;
  const { judge, label } = createJudge();
  const stats = createStats(label);

  const alreadyGone = (e) => e?.code === RESTJSONErrorCodes.UnknownMessage;
  const explain = (e) =>
    e?.code === RESTJSONErrorCodes.MissingPermissions || e?.code === RESTJSONErrorCodes.MissingAccess
      ? `${e.message} (give the bot the Manage Messages permission in this channel)`
      : e?.message ?? String(e);

  // Per-channel delete queue: single delete when idle, bulk delete under load.
  const queues = new Map();
  function enqueueDelete(msg, rec) {
    let q = queues.get(msg.channelId);
    if (!q) queues.set(msg.channelId, (q = { channel: msg.channel, items: [], busy: false }));
    q.items.push({ msg, rec });
    drain(q);
  }
  async function drain(q) {
    if (q.busy || q.items.length === 0) return;
    q.busy = true;
    const batch = q.items.splice(0, 100);
    const t0 = performance.now();
    try {
      if (batch.length === 1) {
        await batch[0].msg.delete().catch((e) => { if (!alreadyGone(e)) throw e; });
        logDeleted(batch, t0);
      } else {
        try {
          // filterOld=true skips messages older than 14 days, which Discord can't bulk delete.
          await q.channel.bulkDelete(batch.map((b) => b.msg.id), true);
          logDeleted(batch, t0);
        } catch (e) {
          // One bad id fails the whole bulk call; fall back to deleting one by one.
          console.warn(`bulk delete of ${batch.length} failed (${explain(e)}), retrying one by one`);
          for (const item of batch) {
            const t1 = performance.now();
            try {
              await item.msg.delete().catch((err) => { if (!alreadyGone(err)) throw err; });
              logDeleted([item], t1);
            } catch (err) {
              stats.errors++;
              console.error(`delete failed: ${explain(err)}  ${quote(item.msg.content)}`);
            }
          }
        }
      }
    } catch (e) {
      stats.errors += batch.length;
      console.error(`delete failed (${batch.length} msg): ${explain(e)}`);
    } finally {
      q.busy = false;
      drain(q);
    }
  }
  function logDeleted(batch, t0) {
    const done = performance.now();
    for (const { msg, rec } of batch) {
      rec.deleteMs = done - t0;
      rec.totalMs = done - rec.recvAt;
      stats.deleted++;
      stats.sample('deleteMs', rec.deleteMs);
      stats.sample('totalMs', rec.totalMs);
      stats.sample('visibleMs', Date.now() - msg.createdTimestamp);
      console.log(
        `🗑️  DELETE  jev ${fmt(rec.jevMs)}  delete ${fmt(rec.deleteMs)}${batch.length > 1 ? ` (bulk ×${batch.length})` : ''}` +
          `  total ${fmt(rec.totalMs)}  p=${rec.p.toFixed(2)} ${rec.category.padEnd(10)} ${quote(msg.content)}`
      );
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
    ],
  });

  let warnedEmpty = false;

  async function onMessage(msg) {
    if (!msg.inGuild() || msg.system) return;
    if (msg.author.id === client.user.id) return;
    if (WATCH && msg.channelId !== WATCH) return;
    if (!msg.content) {
      if (!warnedEmpty && !msg.attachments.size && !msg.embeds.length && !msg.stickers.size) {
        warnedEmpty = true;
        console.warn('⚠️  Got an empty message. Is the Message Content intent enabled for this bot?');
      }
      return;
    }

    const rec = { recvAt: performance.now() };
    stats.seen++;

    await sem.acquire();
    let v;
    try {
      v = await judge(msg.content);
    } catch (e) {
      stats.errors++;
      console.error(`jev error: ${e.message}  ${quote(msg.content)}`);
      return;
    } finally {
      sem.release();
    }

    Object.assign(rec, { jevMs: v.ms, p: v.p, category: v.category });
    stats.sample('jevMs', v.ms);
    stats.tokens += v.tokens;

    const flagged = v.p >= DELETE_AT;
    stats.score(groundTruth(msg), flagged);

    if (flagged) {
      enqueueDelete(msg, rec);
    } else if (v.p >= REVIEW_AT) {
      stats.review++;
      console.log(`🟡 REVIEW  jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(msg.content)}`);
    } else {
      stats.kept++;
      console.log(`✅ keep    jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(msg.content)}`);
    }

    if (stats.seen % 25 === 0) stats.print();
  }

  // Flooder messages come from webhook usernames "troll-###" / "viewer-###",
  // which gives us ground truth for an accuracy number. Jev only ever sees the text.
  function groundTruth(msg) {
    if (!msg.webhookId) return null;
    if (/^troll-\d+$/i.test(msg.author.username)) return true;
    if (/^viewer-\d+$/i.test(msg.author.username)) return false;
    return null;
  }

  client.on(Events.MessageCreate, (msg) =>
    onMessage(msg).catch((e) => {
      stats.errors++;
      console.error(`message handler error: ${e.stack ?? e}`);
    })
  );
  // An unhandled 'error' event would crash the process.
  client.on(Events.Error, (e) => console.error(`discord client error: ${e.message}`));
  client.on(Events.ShardDisconnect, (e, id) => console.warn(`⚠️  Discord shard ${id} disconnected (${e.code}), discord.js will reconnect`));

  onShutdown(async () => {
    stats.print();
    await client.destroy();
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}. Jev via ${label}. Delete at p ≥ ${DELETE_AT}, review at p ≥ ${REVIEW_AT}.`);
    if (WATCH) {
      const ch = await c.channels.fetch(WATCH).catch(() => null);
      if (!ch) console.warn(`⚠️  WATCH_CHANNEL_ID ${WATCH} not found or not visible to the bot. Nothing will be moderated.`);
      else console.log(`Watching #${ch.name ?? WATCH}`);
    } else {
      console.log(`Watching every channel the bot can see (${c.guilds.cache.size} server${c.guilds.cache.size === 1 ? '' : 's'})`);
    }
    console.log('Ctrl+C prints the final summary.\n');
  });

  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (e) {
    if (/disallowed intents/i.test(e.message)) {
      throw new Error('Discord rejected the Message Content intent. Enable it under Bot → Privileged Gateway Intents in the Developer Portal.');
    }
    if (e.code === 'TokenInvalid') throw new Error('DISCORD_TOKEN is invalid. Copy the bot token from the Developer Portal → Bot.');
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flooder: posts a mix of hostile and normal messages through a channel webhook.
// discord.js waits out Discord's rate limits automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function flood(count) {
  requireEnv('FLOOD_WEBHOOK_URL');
  const hook = new WebhookClient({ url: env.FLOOD_WEBHOOK_URL });
  const ratio = num('FLOOD_TOXIC_RATIO', 0.5, { min: 0, max: 1 });

  const t0 = Date.now();
  let hostile = 0;
  try {
    for (let i = 1; i <= count; i++) {
      const m = pick(ratio);
      if (m.hostile) hostile++;
      await hook.send({
        content: m.text,
        username: `${m.hostile ? 'troll' : 'viewer'}-${String(i).padStart(3, '0')}`,
        allowedMentions: { parse: [] },
      });
      process.stdout.write(`\rsent ${i}/${count}`);
    }
  } finally {
    hook.destroy();
  }
  console.log(`\nDone: ${count} messages (${hostile} hostile) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
