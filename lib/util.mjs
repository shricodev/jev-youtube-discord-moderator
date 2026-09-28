// Config parsing, concurrency, stats and log formatting shared by both bots.

const env = process.env;

export function requireEnv(...keys) {
  const missing = keys.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in .env (see .env.example)`);
  }
}

// Blank means default. Invalid values throw, since Number('') is 0 and a DELETE_THRESHOLD
// of 0 would delete every message.
export function num(key, def, { min = -Infinity, max = Infinity, int = false } = {}) {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    const range = `${min === -Infinity ? '' : `>= ${min}`}${min !== -Infinity && max !== Infinity ? ' and ' : ''}${max === Infinity ? '' : `<= ${max}`}`;
    throw new Error(`${key}="${raw}" is invalid: expected ${int ? 'an integer' : 'a number'}${range ? ` ${range}` : ''}`);
  }
  return n;
}

export function thresholds() {
  const DELETE_AT = num('DELETE_THRESHOLD', 0.8, { min: 0, max: 1 });
  const REVIEW_AT = num('REVIEW_THRESHOLD', 0.5, { min: 0, max: 1 });
  if (REVIEW_AT > DELETE_AT) {
    throw new Error(`REVIEW_THRESHOLD (${REVIEW_AT}) must not be above DELETE_THRESHOLD (${DELETE_AT})`);
  }
  return { DELETE_AT, REVIEW_AT };
}

export function floodCount(arg, def = 40) {
  if (arg === undefined) return def;
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Flood count must be a positive integer, got "${arg}"`);
  return n;
}

// Caps concurrent Jev calls so a flood doesn't open hundreds of sockets at once.

export function createSemaphore(max) {
  let inFlight = 0;
  const waiting = [];
  return {
    acquire: () =>
      inFlight < max ? (inFlight++, Promise.resolve()) : new Promise((r) => waiting.push(r)),
    release: () => {
      const next = waiting.shift();
      next ? next() : inFlight--;
    },
  };
}

// Latency samples are kept in a rolling window so a long-running bot doesn't grow forever.
const MAX_SAMPLES = 5000;

export function createStats(jevLabel) {
  const startedAt = Date.now();
  const s = {
    seen: 0, deleted: 0, review: 0, kept: 0, errors: 0, tokens: 0,
    jevMs: [], deleteMs: [], totalMs: [], visibleMs: [],
    tp: 0, fp: 0, tn: 0, fn: 0, // only for flooder messages, which carry ground truth
  };

  s.sample = (key, ms) => {
    const arr = s[key];
    arr.push(ms);
    if (arr.length > MAX_SAMPLES) arr.shift();
  };

  // isTroll: true / false for flooder messages, null for real chat (not scored).
  s.score = (isTroll, flagged) => {
    if (isTroll === null) return;
    if (isTroll && flagged) s.tp++;
    else if (isTroll) s.fn++;
    else if (flagged) s.fp++;
    else s.tn++;
  };

  s.print = () => {
    const labelled = s.tp + s.fp + s.tn + s.fn;
    const secs = Math.max(1, (Date.now() - startedAt) / 1000);
    console.log('\n──────── summary ────────');
    console.log(`messages judged  : ${s.seen}  (${(s.seen / secs).toFixed(2)}/s over ${secs.toFixed(0)}s)`);
    console.log(`deleted/review/kept/errors : ${s.deleted}/${s.review}/${s.kept}/${s.errors}`);
    console.log(`Jev via ${jevLabel.padEnd(9)}: p50 ${fmt(pct(s.jevMs, 50))}  p95 ${fmt(pct(s.jevMs, 95))}`);
    console.log(`delete call      : p50 ${fmt(pct(s.deleteMs, 50))}  p95 ${fmt(pct(s.deleteMs, 95))}`);
    console.log(`receive → deleted: p50 ${fmt(pct(s.totalMs, 50))}  p95 ${fmt(pct(s.totalMs, 95))}`);
    console.log(`visible in chat  : p50 ${fmt(pct(s.visibleMs, 50))}  p95 ${fmt(pct(s.visibleMs, 95))}  (clock-skew sensitive)`);
    console.log(`input tokens     : ${s.tokens}`);
    if (labelled) {
      const acc = ((s.tp + s.tn) / labelled) * 100;
      console.log(
        `flood accuracy   : ${acc.toFixed(1)}%  (caught ${s.tp}/${s.tp + s.fn} trolls, ` +
          `${s.fp} false deletes of ${s.fp + s.tn} normal msgs)`
      );
    }
    console.log('─────────────────────────\n');
  };

  return s;
}

// Runs cleanup once on SIGINT or SIGTERM, then exits. Stray rejections are logged, not fatal.
export function onShutdown(cleanup) {
  let done = false;
  const stop = async (signal) => {
    if (done) return;
    done = true;
    try {
      await cleanup(signal);
    } catch (e) {
      console.error(`shutdown error: ${e.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack ?? e));
}

export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    if (env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
export function fmt(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms`.padStart(6) : '   n/a';
}
export function quote(s) {
  const t = String(s).replace(/\s+/g, ' ');
  return `"${t.length > 60 ? t.slice(0, 57) + '...' : t}"`;
}
