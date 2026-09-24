// jev-mod.mjs
// Discord chat moderator that uses TypeSafe's Jev (via Composio direct execution, no LLM in the loop)
// to judge every message, and discord.js to delete the negative ones.
//
//   node --env-file=.env jev-mod.mjs bot          # run the moderator
//   node --env-file=.env jev-mod.mjs flood 60     # flood the test channel with 60 messages
//
// Requires Node 20.6+ and:  npm i discord.js @composio/core

import { Client, GatewayIntentBits, Events, WebhookClient } from 'discord.js';
import { Composio } from '@composio/core';

const env = process.env;
const mode = process.argv[2] ?? 'bot';

if (mode === 'flood') await flood(Number(process.argv[3] ?? 40));
else if (mode === 'bot') await runBot();
else console.log('Usage: node --env-file=.env jev-mod.mjs [bot | flood <count>]');

// ─────────────────────────────────────────────────────────────────────────────
// Moderator bot
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
  for (const k of ['DISCORD_TOKEN', 'COMPOSIO_API_KEY', 'COMPOSIO_USER_ID']) {
    if (!env[k]) throw new Error(`Missing ${k} in .env`);
  }

  const DELETE_AT = Number(env.DELETE_THRESHOLD ?? 0.8); // noul >= this → delete
  const REVIEW_AT = Number(env.REVIEW_THRESHOLD ?? 0.5); // between → flag only
  const MAX_IN_FLIGHT = Number(env.MAX_IN_FLIGHT ?? 16); // concurrent Jev calls
  const WATCH = env.WATCH_CHANNEL_ID || null; // optional: only moderate one channel

  const composio = new Composio({ apiKey: env.COMPOSIO_API_KEY });
  // Composio requires a toolkit version for direct execution. Pin one if you have it,
  // otherwise run "latest" with the explicit opt-in.
  const versionOpts = env.JEV_TOOLKIT_VERSION
    ? { version: env.JEV_TOOLKIT_VERSION }
    : { dangerouslySkipVersionCheck: true };

  // Both questions run in parallel inside one Jev call.
  const QUESTIONS = {
    negative: {
      type: 'noul',
      instructions:
        'The message is a hostile comment aimed at a person: an insult, harassment, a personal attack, ' +
        'or telling someone to leave. Casual swearing, self-deprecating jokes, complaining about a game ' +
        'or product, and hype like "that was sick" do NOT count.',
    },
    category: {
      type: 'choice',
      criteria: {
        insult: 'Insults or belittles someone',
        harassment: 'Targets, dismisses or tells someone to go away',
        spam: 'Repetitive, promotional or meaningless flooding',
        fine: 'Normal chat, including jokes, hype and mild frustration',
      },
    },
  };

  async function judge(text) {
    const t0 = performance.now();
    const res = await composio.tools.execute('JEV_EVALUATE_STATE', {
      userId: env.COMPOSIO_USER_ID,
      arguments: {
        state: text,
        questions: QUESTIONS,
        ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
      },
      ...versionOpts,
    });
    const ms = performance.now() - t0;
    if (!res.successful) throw new Error(res.error || 'JEV_EVALUATE_STATE failed');
    const a = res.data.answers;
    return {
      ms,
      p: a.negative.noul,
      category: a.category.choice,
      tokens: res.data.usage?.input_tokens ?? 0,
    };
  }

  // ── tiny semaphore so a flood doesn't open hundreds of sockets at once
  let inFlight = 0;
  const waiting = [];
  const acquire = () =>
    inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise((r) => waiting.push(r));
  const release = () => {
    const next = waiting.shift();
    next ? next() : inFlight--;
  };

  // ── stats
  const stats = {
    seen: 0, deleted: 0, review: 0, kept: 0, errors: 0, tokens: 0,
    jevMs: [], totalMs: [], visibleMs: [],
    tp: 0, fp: 0, tn: 0, fn: 0, // only for flooder messages (labelled by webhook username)
  };
  const startedAt = Date.now();

  // ── per-channel delete queue: single delete when idle, bulk delete under load
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
      if (batch.length === 1) await batch[0].msg.delete();
      else await q.channel.bulkDelete(batch.map((b) => b.msg.id), true);
      const done = performance.now();
      for (const { msg, rec } of batch) {
        rec.deleteMs = done - t0;
        rec.totalMs = done - rec.recvAt;
        rec.visibleMs = Date.now() - msg.createdTimestamp;
        stats.deleted++;
        stats.totalMs.push(rec.totalMs);
        stats.visibleMs.push(rec.visibleMs);
        console.log(
          `🗑️  DELETE  jev ${fmt(rec.jevMs)}  delete ${fmt(rec.deleteMs)}${batch.length > 1 ? ` (bulk ×${batch.length})` : ''}` +
            `  total ${fmt(rec.totalMs)}  p=${rec.p.toFixed(2)} ${rec.category.padEnd(10)} ${quote(msg.content)}`
        );
      }
    } catch (e) {
      stats.errors++;
      console.error(`delete failed (${batch.length} msg): ${e.message}`);
    } finally {
      q.busy = false;
      drain(q);
    }
  }

  // ── Discord client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
    ],
  });

  let warnedEmpty = false;

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.id === client.user.id) return;
    if (WATCH && msg.channelId !== WATCH) return;
    if (!msg.content) {
      if (!warnedEmpty && !msg.attachments.size) {
        warnedEmpty = true;
        console.warn('⚠️  Got an empty message. Is the Message Content intent enabled for this bot?');
      }
      return;
    }

    const rec = { recvAt: performance.now() };
    stats.seen++;

    await acquire();
    let v;
    try {
      v = await judge(msg.content);
    } catch (e) {
      stats.errors++;
      console.error(`jev error: ${e.message}`);
      return;
    } finally {
      release();
    }

    Object.assign(rec, { jevMs: v.ms, p: v.p, category: v.category });
    stats.jevMs.push(v.ms);
    stats.tokens += v.tokens;

    const flagged = v.p >= DELETE_AT;
    score(msg.author.username, flagged);

    if (flagged) {
      enqueueDelete(msg, rec);
    } else if (v.p >= REVIEW_AT) {
      stats.review++;
      console.log(`🟡 REVIEW  jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(msg.content)}`);
    } else {
      stats.kept++;
      console.log(`✅ keep    jev ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} ${quote(msg.content)}`);
    }

    if (stats.seen % 25 === 0) printSummary();
  });

  // Flooder messages come from webhook usernames "troll-###" / "viewer-###",
  // which gives us ground truth for an accuracy number. Jev only ever sees the text.
  function score(username, flagged) {
    const isTroll = /^troll-/i.test(username);
    const isViewer = /^viewer-/i.test(username);
    if (!isTroll && !isViewer) return;
    if (isTroll && flagged) stats.tp++;
    else if (isTroll) stats.fn++;
    else if (flagged) stats.fp++;
    else stats.tn++;
  }

  function printSummary() {
    const labelled = stats.tp + stats.fp + stats.tn + stats.fn;
    const secs = (Date.now() - startedAt) / 1000;
    console.log('\n──────── summary ────────');
    console.log(`messages judged : ${stats.seen}  (${(stats.seen / secs).toFixed(2)}/s over ${secs.toFixed(0)}s)`);
    console.log(`deleted/review/kept/errors : ${stats.deleted}/${stats.review}/${stats.kept}/${stats.errors}`);
    console.log(`Jev via Composio : p50 ${fmt(pct(stats.jevMs, 50))}  p95 ${fmt(pct(stats.jevMs, 95))}`);
    console.log(`receive → deleted: p50 ${fmt(pct(stats.totalMs, 50))}  p95 ${fmt(pct(stats.totalMs, 95))}`);
    console.log(`visible in chat  : p50 ${fmt(pct(stats.visibleMs, 50))}  p95 ${fmt(pct(stats.visibleMs, 95))}  (clock-skew sensitive)`);
    console.log(`input tokens     : ${stats.tokens}`);
    if (labelled) {
      const acc = ((stats.tp + stats.tn) / labelled) * 100;
      console.log(
        `flood accuracy   : ${acc.toFixed(1)}%  (caught ${stats.tp}/${stats.tp + stats.fn} trolls, ` +
          `${stats.fp} false deletes of ${stats.fp + stats.tn} normal msgs)`
      );
    }
    console.log('─────────────────────────\n');
  }

  process.on('SIGINT', () => {
    printSummary();
    client.destroy();
    process.exit(0);
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}. Delete at p ≥ ${DELETE_AT}, review at p ≥ ${REVIEW_AT}.`);
    console.log(WATCH ? `Watching channel ${WATCH}` : 'Watching every channel the bot can see');
    console.log('Ctrl+C prints the final summary.\n');
  });

  await client.login(env.DISCORD_TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flooder: posts a mix of hostile and normal messages through a channel webhook.
// discord.js waits out Discord's rate limits automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function flood(count) {
  if (!env.FLOOD_WEBHOOK_URL) throw new Error('Missing FLOOD_WEBHOOK_URL in .env');
  const hook = new WebhookClient({ url: env.FLOOD_WEBHOOK_URL });
  const ratio = Number(env.FLOOD_TOXIC_RATIO ?? 0.5);

  const HOSTILE = [
    'nobody asked for your opinion, go away',
    "you are genuinely the worst player I've ever watched",
    'lmao imagine being this bad, uninstall',
    'this streamer is a clown and so is everyone in chat',
    'shut up already, no one likes you',
    "you're so dumb it hurts to read your messages",
    'get out of this server, loser',
    'your content is trash and you should quit',
    'cry about it, crybaby',
    'embarrassing. do everyone a favor and log off',
    'every word you type makes this chat worse',
    'stop talking, your takes are braindead',
    'ratio + you fell off + nobody cares',
  ];

  // Includes tricky-but-fine lines: negative words that aren't aimed at a person.
  const NORMAL = [
    'gg that was a close one',
    'this boss is absolutely killing me lol',
    'I hate how catchy this song is',
    'that play was sick, how did you pull that off',
    'lag is terrible today, anyone else?',
    'welcome back everyone!',
    'ok that was a terrible decision by me lmao',
    'can someone link the patch notes?',
    'this game is brutal but I love it',
    'brb grabbing food',
    'no way, that ending was insane',
    'honestly the new update kinda sucks, the menus are confusing',
    "you're crazy good at this",
    "lol I died again, I'm so bad at this",
  ];

  const t0 = Date.now();
  let hostile = 0;
  for (let i = 1; i <= count; i++) {
    const isHostile = Math.random() < ratio;
    if (isHostile) hostile++;
    const pool = isHostile ? HOSTILE : NORMAL;
    await hook.send({
      content: pool[Math.floor(Math.random() * pool.length)],
      username: `${isHostile ? 'troll' : 'viewer'}-${String(i).padStart(3, '0')}`,
    });
    process.stdout.write(`\rsent ${i}/${count}`);
  }
  console.log(`\nDone: ${count} messages (${hostile} hostile) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  hook.destroy();
}

// ── helpers
function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function fmt(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms`.padStart(6) : '   n/a';
}
function quote(s) {
  const t = s.replace(/\s+/g, ' ');
  return `"${t.length > 60 ? t.slice(0, 57) + '...' : t}"`;
}
