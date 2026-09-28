// Verifies the Jev path (Composio by default, or OpenRouter with JEV_PROVIDER=openrouter)
// works before touching Discord or Twitch.
//
//   npm run preflight

import { createJudge } from './lib/jev.mjs';
import { fmt, main } from './lib/util.mjs';

await main(async () => {
  const { judge, label } = createJudge();
  console.log(`Checking Jev via ${label}...\n`);

  const samples = [
    ['nobody asked for your opinion, go away', true],
    ['this boss is absolutely killing me lol', false],
  ];

  let unexpected = 0;
  for (const [text, expectHostile] of samples) {
    const v = await judge(text);
    const ok = expectHostile ? v.p >= 0.5 : v.p < 0.5;
    if (!ok) unexpected++;
    console.log(`${ok ? '✅' : '⚠️ '} ${fmt(v.ms)}  p=${v.p.toFixed(2)} ${v.category.padEnd(10)} "${text}"`);
  }

  console.log(
    unexpected
      ? `\nJev answered, but ${unexpected} verdict(s) looked off. The connection works; check JEV_MODEL.`
      : `\nPreflight done. ${label} → Jev works.`
  );
});
