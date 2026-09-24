// preflight.mjs: verifies the Composio → Jev path works before touching Discord.
import { Composio } from '@composio/core';

const env = process.env;
for (const k of ['COMPOSIO_API_KEY', 'COMPOSIO_USER_ID']) {
  if (!env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const composio = new Composio({ apiKey: env.COMPOSIO_API_KEY });
const versionOpts = env.JEV_TOOLKIT_VERSION
  ? { version: env.JEV_TOOLKIT_VERSION }
  : { dangerouslySkipVersionCheck: true };

const samples = [
  ['nobody asked for your opinion, go away', true],
  ['this boss is absolutely killing me lol', false],
];

for (const [text, expectHostile] of samples) {
  const t0 = performance.now();
  const res = await composio.tools.execute('JEV_EVALUATE_STATE', {
    userId: env.COMPOSIO_USER_ID,
    arguments: {
      state: text,
      questions: {
        negative: {
          type: 'noul',
          instructions: 'The message is a hostile comment aimed at a person: an insult, harassment, a personal attack, or telling someone to leave.',
        },
      },
      ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
    },
    ...versionOpts,
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.successful) {
    console.error('❌ Jev call failed:', res.error);
    console.error('Full response:', JSON.stringify(res, null, 2));
    process.exit(1);
  }
  const p = res.data.answers.negative.noul;
  const ok = expectHostile ? p >= 0.5 : p < 0.5;
  console.log(`${ok ? '✅' : '⚠️ '} ${ms}ms  p=${p.toFixed(2)}  "${text}"`);
}
console.log('\nPreflight done. Composio → Jev works.');
