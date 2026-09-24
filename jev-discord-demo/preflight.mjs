// preflight.mjs: verifies the OpenRouter → Jev path works before touching Discord.
// The Composio version of this file lives in composio-version/.
const env = process.env;
if (!env.OPENROUTER_API_KEY) { console.error('Missing OPENROUTER_API_KEY in .env'); process.exit(1); }

const JEV_URL = 'https://openrouter.ai/api/v1/systemone';
const JEV_MODEL = env.JEV_MODEL || '~typesafe/jev-latest';

const samples = [
  ['nobody asked for your opinion, go away', true],
  ['this boss is absolutely killing me lol', false],
];

for (const [text, expectHostile] of samples) {
  const t0 = performance.now();
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: text,
      questions: {
        negative: {
          type: 'noul',
          instructions: 'The message is a hostile comment aimed at a person: an insult, harassment, a personal attack, or telling someone to leave.',
        },
      },
    }),
    signal: AbortSignal.timeout(Number(env.JEV_TIMEOUT_MS ?? 10000)),
  });
  const body = await res.json().catch(() => null);
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    console.error(`❌ Jev call failed: HTTP ${res.status}`);
    console.error('Full response:', JSON.stringify(body, null, 2));
    process.exit(1);
  }
  const p = body.answers.negative.noul;
  const ok = expectHostile ? p >= 0.5 : p < 0.5;
  console.log(`${ok ? '✅' : '⚠️ '} ${ms}ms  p=${p.toFixed(2)}  "${text}"  (model ${body.model})`);
}
console.log('\nPreflight done. OpenRouter → Jev works.');
