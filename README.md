<div align="center">

# Jev Live-Chat Moderator

Real-time moderation for Discord and Twitch chat, powered by TypeSafe's Jev decision model.

<br />

<a href="https://composio.dev"><img src="https://img.shields.io/badge/Built%20with-Composio-000000?style=for-the-badge&labelColor=1a1a1a" alt="Built with Composio" /></a>
<a href="https://composio.dev/toolkits/jev"><img src="https://img.shields.io/badge/Model-Jev%20by%20TypeSafe-4f46e5?style=for-the-badge&labelColor=1a1a1a" alt="Jev by TypeSafe" /></a>
<br />
<img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1a1a1a" alt="Node.js 22+" />
<img src="https://img.shields.io/badge/Discord-supported-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=1a1a1a" alt="Discord" />
<img src="https://img.shields.io/badge/Twitch-supported-9146FF?style=for-the-badge&logo=twitch&logoColor=white&labelColor=1a1a1a" alt="Twitch" />

</div>

<br />

These bots delete hostile chat messages within about a second of posting, with no LLM in the loop. Each message is sent to [Jev](https://composio.dev/toolkits/jev) as a typed question through Composio. Jev returns the probability that the message is a hostile comment aimed at a person, and the bot acts on that number:

```
new chat message
   │
   ▼
Jev (via Composio's JEV_EVALUATE_STATE, or OpenRouter)
   ├── negative: noul   → "is this a hostile comment aimed at a person?"
   └── category: choice → insult / harassment / spam / fine
   │
   ▼
p ≥ 0.8  → delete the message
p ≥ 0.5  → log it for review
else     → keep it
```

- **Discord:** `discord.js` receives and deletes messages, using bulk deletes under load.
- **Twitch:** EventSub over WebSocket delivers messages, and the Helix API deletes them. Reconnects and a keepalive watchdog are built in.

Each platform ships with a **flooder** that posts a mix of hostile and tricky-but-benign messages, so you can measure latency and accuracy.

> **Note:** This project is a demonstration and is not a replacement for human moderators. It removes clear-cut abuse quickly so moderators can focus on ambiguous cases.

## Requirements

- Node.js **22+**
- A [Composio](https://dashboard.composio.dev) account with the Jev toolkit connected (or an [OpenRouter](https://openrouter.ai) key, see [Providers](#providers))
- A Discord bot and/or a Twitch app

## Quick start

```bash
git clone https://github.com/shricodev/jev-youtube-discord-moderator
cd jev-youtube-discord-moderator
npm install
cp .env.example .env    # then fill it in, see below
npm run preflight       # checks that Jev answers before touching any chat platform
```

### 1. Connect Jev in Composio

1. Get your API key from the [Composio dashboard](https://dashboard.composio.dev) and set it as `COMPOSIO_API_KEY`.
2. Add the [Jev toolkit](https://composio.dev/toolkits/jev) and connect it with your **TypeSafe API key**.
3. Set `COMPOSIO_USER_ID` to the user ID the connection belongs to. Every tool call is scoped to that user.

Then run `npm run preflight`. The output should look like this:

```
Checking Jev via Composio...

✅   412ms  p=0.97 harassment "nobody asked for your opinion, go away"
✅   388ms  p=0.04 fine       "this boss is absolutely killing me lol"

Preflight done. Composio → Jev works.
```

An error such as `No connected account found for user ID ...` means the Jev connection is missing, belongs to a different user ID, or has expired. Reconnect it in the dashboard.

### 2a. Discord

1. Create an application and a bot in the [Developer Portal](https://discord.com/developers/applications), and copy the bot token into `DISCORD_TOKEN`.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Without it, message content arrives empty.
3. Invite the bot with the `View Channel`, `Read Message History` and `Manage Messages` permissions:
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=74752`
4. Optional: set `WATCH_CHANNEL_ID` to limit the bot to one channel (recommended while testing).
5. For the flooder only: create a **webhook** in the test channel and set `FLOOD_WEBHOOK_URL`.

```bash
npm run bot            # terminal 1: the moderator
npm run flood -- 60    # terminal 2: post 60 test messages
```

### 2b. Twitch

1. Register an app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) with **Client Type: Public**. The OAuth redirect URL can be `http://localhost`, since it's never used. Copy the Client ID into `TWITCH_CLIENT_ID`.
2. Log in the bot account. This uses Twitch's device code flow: it prints a link and a code, and you approve it in the browser.
   ```bash
   npm run twitch:auth -- bot
   ```
   Use the channel owner, or an account that is a **moderator** in `TWITCH_CHANNEL`.
3. For the flooder only: log in a **second, regular account**. Twitch does not allow deleting messages from the broadcaster or moderators, so messages sent from your own account are never removed.
   ```bash
   npm run twitch:auth -- flooder
   ```
4. For flood tests, turn off AutoMod, blocked terms and the non-mod chat delay in your channel's moderation settings. Otherwise Twitch filters the flood before it reaches the bot.

```bash
npm run twitch:bot            # terminal 1: the moderator
npm run twitch:flood -- 60    # terminal 2: post 60 test messages as the flooder
```

Tokens are stored in `.twitch-tokens.json` (gitignored, mode `600`) and refresh automatically. If a refresh fails, the bot prints the `twitch:auth` command to re-run.

## Reading the output

```
✅ keep    jev  389ms  p=0.06 fine       "gg that was a close one"
🟡 REVIEW  jev  909ms  p=0.73 insult     "every word you type makes this chat worse"
🗑️  DELETE  jev  341ms  delete  641ms  total  984ms  p=0.92 insult     "lmao imagine being this bad, uninstall"
```

- `jev`: how long the Jev call took.
- `delete`: how long the platform took to delete the message.
- `total`: time from the bot receiving the message to the message being gone.

A summary prints every 25 messages and on Ctrl+C or SIGTERM. It shows p50/p95 latencies, token usage and, for flooder messages, accuracy against ground truth.

## Configuration

Everything lives in `.env`. Optional values fall back to their defaults when blank. Invalid values are rejected at startup.

| Variable | Default | Description |
| --- | --- | --- |
| `JEV_PROVIDER` | `composio` | `composio` or `openrouter` |
| `COMPOSIO_API_KEY` | | Composio API key |
| `COMPOSIO_USER_ID` | | User ID that owns the Jev connection |
| `JEV_TOOLKIT_VERSION` | latest | Pin the Jev toolkit version (recommended in production) |
| `OPENROUTER_API_KEY` | | Only for `JEV_PROVIDER=openrouter` |
| `JEV_MODEL` | provider default | For example `typesafe/jev-1.13` |
| `JEV_TIMEOUT_MS` | `10000` | Abort a Jev call after this long |
| `DELETE_THRESHOLD` | `0.8` | Delete at `p ≥` this |
| `REVIEW_THRESHOLD` | `0.5` | Log as REVIEW at `p ≥` this, below the delete threshold |
| `MAX_IN_FLIGHT` | `16` | Maximum concurrent Jev calls |
| `DISCORD_TOKEN` | | Discord bot token |
| `WATCH_CHANNEL_ID` | all channels | Only moderate this Discord channel |
| `FLOOD_WEBHOOK_URL` | | Discord webhook the flooder posts through |
| `TWITCH_CLIENT_ID` | | Twitch app Client ID (Public client) |
| `TWITCH_CHANNEL` | bot's own channel | Twitch channel login to moderate |
| `FLOOD_TOXIC_RATIO` | `0.5` | Share of hostile messages in a flood |
| `FLOOD_INTERVAL_MS` | `1600` | Gap between Twitch flood messages |

## Providers

The Jev call lives in [`lib/jev.mjs`](lib/jev.mjs) and is shared by both bots.

- **`composio`** (default): one `composio.tools.execute('JEV_EVALUATE_STATE', ...)` call. Composio stores the TypeSafe key, so the code holds no Jev credentials. Direct execution needs a toolkit version: set `JEV_TOOLKIT_VERSION` to pin one, or leave it blank to run the latest (the code passes `dangerouslySkipVersionCheck` for you).
- **`openrouter`**: calls OpenRouter's System One API with `fetch`. This bypasses Composio and is useful for benchmarking raw Jev latency.

## Running it long-term

The bots are single Node processes with no state beyond `.twitch-tokens.json`, so any process manager works. They shut down cleanly on SIGTERM, printing a final summary, and log recoverable errors rather than exiting. For example:

```bash
pm2 start npm --name jev-discord -- run bot
pm2 start npm --name jev-twitch  -- run twitch:bot
```

Operational notes:

- Message text is logged to stdout. Treat those logs as chat data.
- Twitch refresh tokens for public clients can expire, for example after long inactivity or a password change. If the bot exits with a refresh error, run `npm run twitch:auth -- bot` again.
- If the Twitch EventSub subscription is revoked (for example because the bot lost mod status), the bot exits with code 1 so your process manager can surface it.

## Project layout

```
.
├── jev-mod.mjs       Discord bot + webhook flooder
├── twitch-mod.mjs    Twitch bot + flooder + device-code auth
├── preflight.mjs     One-shot check that Jev answers
└── lib/
    ├── jev.mjs       The shared Jev call (Composio / OpenRouter)
    ├── pools.mjs     Flood message pools (ground truth for accuracy)
    └── util.mjs      Config parsing, semaphore, stats, logging
```

## Extending to YouTube Live

YouTube Live is not included, but the Jev integration carries over unchanged. Poll `liveChatMessages.list` (or use `streamList`), pass each message to `judge()` from `lib/jev.mjs`, and call `liveChatMessages.delete` above the threshold. Note that the YouTube Data API quota is limited: each insert or delete costs 50 of the default 10,000 daily units.
