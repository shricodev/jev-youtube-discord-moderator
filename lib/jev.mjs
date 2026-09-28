// The Jev call both bots share. One request, two questions answered in parallel:
//   negative: noul   → probability the message is a hostile comment aimed at a person
//   category: choice → insult / harassment / spam / fine (only for readable logs)
//
// JEV_PROVIDER picks how Jev is reached:
//   composio   (default)  Composio direct tool execution of JEV_EVALUATE_STATE
//   openrouter            OpenRouter's System One API, called with plain fetch

import { Composio } from '@composio/core';
import { num, requireEnv } from './util.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/systemone';

export const QUESTIONS = {
  negative: {
    type: 'noul',
    instructions:
      'The message is a hostile comment aimed at a person: an insult, harassment, a personal attack, ' +
      'or telling someone to leave. Casual swearing, self-deprecating jokes, complaining about a game ' +
      'or product, and hype like "that was sick" do NOT count.',
  },
  category: {
    type: 'choice',
    // OpenRouter requires instructions on choice questions (Composio treats them as optional).
    instructions: 'Which kind of message is this?',
    criteria: {
      insult: 'Insults or belittles someone',
      harassment: 'Targets, dismisses or tells someone to go away',
      spam: 'Repetitive, promotional or meaningless flooding',
      fine: 'Normal chat, including jokes, hype and mild frustration',
    },
  },
};

export function createJudge() {
  const env = process.env;
  const provider = (env.JEV_PROVIDER?.trim() || 'composio').toLowerCase();
  const timeoutMs = num('JEV_TIMEOUT_MS', 10000, { min: 100 });
  const model = env.JEV_MODEL?.trim();

  let call;
  if (provider === 'composio') {
    requireEnv('COMPOSIO_API_KEY', 'COMPOSIO_USER_ID');
    const composio = new Composio({ apiKey: env.COMPOSIO_API_KEY });
    // Composio requires a toolkit version for direct execution. Pin one for production,
    // otherwise run "latest" with the explicit opt-in.
    const toolkitVersion = env.JEV_TOOLKIT_VERSION?.trim();
    const versionOpts = toolkitVersion ? { version: toolkitVersion } : { dangerouslySkipVersionCheck: true };

    call = async (text, questions, signal) => {
      let res;
      try {
        res = await composio.tools.execute(
          'JEV_EVALUATE_STATE',
          {
            userId: env.COMPOSIO_USER_ID,
            arguments: { state: text, questions, ...(model ? { model } : {}) },
            ...versionOpts,
          },
          { signal }
        );
      } catch (e) {
        throw composioError(e);
      }
      if (!res.successful) throw new Error(`JEV_EVALUATE_STATE failed: ${res.error || 'no error message'}`);
      return { answers: res.data?.answers, usage: res.data?.usage };
    };
  } else if (provider === 'openrouter') {
    requireEnv('OPENROUTER_API_KEY');
    call = async (text, questions, signal) => {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: model || '~typesafe/jev-latest', state: text, questions }),
        signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
      return { answers: body?.answers, usage: body?.usage };
    };
  } else {
    throw new Error(`JEV_PROVIDER must be "composio" or "openrouter", got "${env.JEV_PROVIDER}"`);
  }

  async function judge(text, questions = QUESTIONS) {
    const t0 = performance.now();
    let out;
    try {
      out = await call(text, questions, AbortSignal.timeout(timeoutMs));
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'ComposioRequestCancelledError') {
        throw new Error(`Jev call timed out after ${timeoutMs}ms`);
      }
      throw e;
    }
    const p = out.answers?.negative?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p)) {
      throw new Error(`Unexpected Jev response: ${JSON.stringify(out.answers ?? null).slice(0, 300)}`);
    }
    const category = out.answers?.category?.choice;
    return {
      ms: performance.now() - t0,
      p,
      category: typeof category === 'string' ? category : '?',
      tokens: out.usage?.input_tokens ?? 0,
    };
  }

  return { judge, provider, label: provider === 'composio' ? 'Composio' : 'OpenRouter' };
}

// The SDK reports API failures as "Error executing the tool"; the real reason is on a nested cause.
function composioError(e) {
  if (e?.name === 'ComposioRequestCancelledError') return e;
  let apiError;
  for (let c = e; c && !apiError; c = c.cause) apiError = c.error?.error ?? (c.status ? c.error : undefined);
  const slug = apiError?.slug ?? '';
  const hint =
    /ConnectedAccountNotFound|ConnectedAccount.*(Expired|Inactive)/i.test(slug) || /connected account/i.test(apiError?.message ?? '')
      ? ' → In the Composio dashboard, connect the Jev toolkit (with your TypeSafe API key) under the same user ID as COMPOSIO_USER_ID, and make sure the connection is ACTIVE, not EXPIRED.'
      : /api.?key|unauthori[sz]ed|401/i.test(`${slug} ${apiError?.message ?? e?.message}`)
        ? ' → Check COMPOSIO_API_KEY.'
        : '';
  const detail = apiError?.message ?? e?.cause?.message ?? e?.message ?? String(e);
  return new Error(`Composio: ${detail}${hint}`, { cause: e });
}
