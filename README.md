# svm402-agent

> Gemini-driven agent that exercises the [base-token-oracle](https://github.com/dchu3/base-token-oracle) x402 payment flow against Base mainnet via CLI or Telegram.

An interactive agent where you chat in natural language about Base ERC-20 tokens. Gemini decides which oracle endpoint to call (`/report`), and the client signs a real USDC `transferWithAuthorization` per call via x402 v2.

> **⚠️ Real money.** Every successful tool call settles real USDC on Base mainnet (chainId 8453). Use the `MAX_SPEND_USDC` cap.

## Features

- **CLI REPL:** Rich terminal interface with spinners, tables, and a real-time spend bar.
- **Telegram Bot:** A private, authenticated bot interface to chat with the agent on the go.
- **x402 Payments:** Automatic signing and settlement of micro-payments for oracle reports.
- **Gemini Powered:** Natural language analysis of token metadata, holders, and concentration data.

## Quick start

```bash
git clone <this repo>
cd svm402-agent
cp .env.example .env
# edit .env — set PRIVATE_KEY, GEMINI_API_KEY, ORACLE_URL
# Optional: set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID to use the bot
npm install
npm run build
npm start
```

## Telegram Bot

The agent includes a built-in Telegram bot providing a polished mobile experience. To enable it:
1. Create a bot via [@BotFather](https://t.me/botfather) and get the `TELEGRAM_BOT_TOKEN`.
2. Get your numeric Telegram User ID (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` in your `.env`.
4. Run `npm start`. If the token is present, the agent launches the bot instead of the REPL.

### Features
- **Structured Reports:** Clear, emoji-rich token safety summaries designed for mobile readability.
- **Command Menu:** Access common tasks (`/balance`, `/spend`, `/receipts`, etc.) via the bot's menu button.
- **Real-time Feedback:** Live status updates for tool calls (signing, settling, and analysis).
- **Private Access:** Strictly authenticated to your specific User ID.
- **History Management:** `/clear` command to reset the agent's conversation memory.

The bot is **strictly private** and will only respond to the authorized user ID.

## Configuration

| Var | Required | Default | Notes |
|---|---|---|---|
| `ORACLE_URL` | no | `https://svm402.com` | Base URL of a running base-token-oracle |
| `PRIVATE_KEY` | **yes** | — | 0x-prefixed 32-byte hex; wallet must hold USDC on Base |
| `GEMINI_API_KEY` | **yes** | — | from [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `TELEGRAM_BOT_TOKEN` | no | — | Telegram Bot API token |
| `TELEGRAM_ALLOWED_USER_ID` | no | — | Numeric ID of the authorized Telegram user |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite-preview` | preview model; also fine: `gemini-2.5-flash`, `gemini-2.5-pro` |
| `MAX_SPEND_USDC` | no | `0.10` | Hard cap on cumulative session spend |
| `DEBUG` | no | `0` | `1` for verbose logs |
| `DISABLE_X402` | no | `0` | `1` disables x402 payment wrapper (useful with DEBUG=1) |
| `NO_COLOR` | no | unset | Standard env var; disables all colors when set |
| `SVM402_ASCII` | no | `0` | `1` falls back to plain ASCII glyphs/borders (for picky terminals) |
| `SVM402_PROMPT` | no | `rich` | `plain` falls back to `svm402> ` prompt |
| `SVM402_NO_SPINNER` | no | `0` | `1` disables in-flight spinners (useful when piping output) |
| `DEXSCREENER_MCP_PATH` | no | `../dex-screener-mcp/dist/index.js` | Path to the built dex-screener-mcp `index.js` |
| `SCHEDULER_ENABLED` | no | `1` | `0` disables the periodic trending-token scan |
| `SCHEDULER_INTERVAL_MINUTES` | no | `60` | How often the scheduler tick runs |
| `WATCHLIST_MAX_SIZE` | no | `10` | Maximum tokens kept on the curated watchlist |
| `WATCHLIST_DB_PATH` | no | `./data/watchlist.db` | SQLite path for the watchlist |
| `TRADING_ENABLED` | no | `0` | Enable the automated trading engine |
| `TRADING_LIVE` | no | `0` | `1` enables real swaps; otherwise dry-run only |
| `TRADING_MIN_SCORE` | no | `80` | Watchlist score threshold for auto-buy |
| `TRADE_SIZE_USDC` | no | `5` | Fixed entry size per trade |
| `MAX_OPEN_POSITIONS` | no | `3` | Cap on concurrently open positions |
| `TP_PCT` / `SL_PCT` / `TRAILING_STOP_PCT` | no | `50` / `20` / `15` | Exit policy thresholds (%) |
| `MAX_HOLD_MINUTES` | no | `1440` | Max hold time per position (minutes) |
| `TRADING_SLIPPAGE_BPS` | no | `100` | Slippage tolerance in basis points |
| `TRADING_MONITOR_INTERVAL_SEC` | no | `60` | Position monitor cadence |
| `TRADING_DEX` | no | `uniswap-v3` | DEX adapter to use |
| `TRADING_DB_PATH` | no | `./data/trading.db` | SQLite path for positions/trades |

## DexScreener watchlist scheduler

The agent can periodically pull **trending tokens on Base** from
DexScreener (via the [`dex-screener-mcp`](https://github.com/dchu3/dex-screener-mcp)
MCP server) and cross-reference each one against the oracle `/report`
endpoint. Candidates are sourced from `/latest/dex/search` using a small
set of Base-relevant seed queries (`"WETH base"`, `"USDC base"`, `"base"` —
the literal word "base" in the query is what narrows DexScreener's
cross-chain search index to Base pairs), filtered to `chainId=base`,
deduped by pair address, and ranked by aggregated 24h volume. Well-known
infrastructure tokens (WETH, USDC, DAI, cbETH, …) and sentinel addresses
are excluded. Gemini ranks every candidate; high-quality tokens are added to a
local SQLite watchlist (max `WATCHLIST_MAX_SIZE`, default 10) and lower-ranked
ones are evicted automatically. Adds, removes and replaces are broadcast to
both the CLI and the Telegram bot (when configured).

> **Why volume-based search instead of boosted tokens?** DexScreener's
> `/token-boosts/*` feeds are global and dominated by Solana listings, so a
> Base-filtered subset is frequently empty. The pair-search endpoint
> exposes per-pair `chainId` plus 24h volume/txns, which produces a much
> richer Base candidate pool.

### Setup

1. Clone and build `dex-screener-mcp` next to `svm402-agent`:
   ```bash
   git clone https://github.com/dchu3/dex-screener-mcp ../dex-screener-mcp
   (cd ../dex-screener-mcp && npm install && npm run build)
   ```
   Override the location with `DEXSCREENER_MCP_PATH` if needed.
2. Ensure `MAX_SPEND_USDC` is high enough — each scan can fetch up to
   `WATCHLIST_MAX_SIZE` reports at $0.01 USDC each. With the default cap of
   `0.10`, the scheduler will gracefully short-circuit once the cap is hit.

### Slash / bot commands

| Command | Description |
|---|---|
| `/balance` | Show wallet address + USDC balance on Base |
| `/spend` | Show session spend vs cap |
| `/receipts` | List recent settled payments |
| `/watchlist` | Show the curated watchlist with scores and full contract addresses |
| `/scan` | Run a watchlist scheduler tick on demand |
| `/scheduler on\|off` | Toggle the periodic scanner (no arg shows status) |
| `/positions` | Show open trading positions |
| `/trades` | Show recent trades (last 20) |
| `/trade-on` / `/trade-off` (REPL) or `/trade_on` / `/trade_off` (Telegram) | Toggle the trading engine |
| `/trade-status` (REPL) or `/trade_status` (Telegram) | Show trading engine config and open count |
| `/sell <addr>` | Manually close an open position |
| `/clear` | Reset the agent's chat history |
| `/help` | Show the in-bot help message |

Watchlist add/remove/replace notifications include the **full** contract
address. On Telegram the address is rendered in a monospace span so you can
tap to copy it directly into another tool.

## Automated trading (Base)

The agent ships with an opt-in **automated trading engine** that swaps USDC
for tokens on Base mainnet whenever a watchlist add/replace event arrives
with a score above a configurable threshold. It manages exits via
take-profit, stop-loss, trailing-stop and max-hold rules.

> ⚠️ **Real money.** When live mode is enabled the engine signs and sends
> real swaps with the wallet's USDC. Start in dry-run, set conservative
> sizes, and never run this with a key holding more value than you are
> willing to lose. There is no MEV protection.

### Modes

- **Disabled** (`TRADING_ENABLED=0`, the default) — engine is not started; no
  trades are evaluated.
- **Dry-run** (`TRADING_ENABLED=1`, `TRADING_LIVE=0`) — engine evaluates
  triggers, records dry-run "trades" and "positions" in the trading DB, and
  prints/sends notifications, but never sends a transaction.
- **Live** (`TRADING_ENABLED=1`, `TRADING_LIVE=1`) — engine signs and sends
  real Uniswap v3 swaps on Base.

### DEX adapter

The first adapter is **Uniswap v3** on Base (SwapRouter02
`0x2626664c2603336E57B271c5C0b26F421741e481`, QuoterV2
`0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`). It probes fee tiers
`100 / 500 / 3000 / 10000` and picks the best `amountOut`. The DEX is
pluggable via the `DexAdapter` interface; new venues can be registered in
`src/trading/dex/index.ts`.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TRADING_ENABLED` | `0` | Master switch for the engine. |
| `TRADING_LIVE` | `0` | Must be `1` to send real txs; otherwise everything is dry-run. |
| `TRADING_MIN_SCORE` | `80` | Watchlist score threshold for auto-buy. |
| `TRADE_SIZE_USDC` | `5` | Fixed entry size per trade (USDC). |
| `MAX_OPEN_POSITIONS` | `3` | Hard cap on concurrently open positions. |
| `TP_PCT` | `50` | Take-profit, % above entry. |
| `SL_PCT` | `20` | Stop-loss, % below entry. |
| `TRAILING_STOP_PCT` | `15` | Trailing stop, % drawdown from peak (only after peak > entry). |
| `MAX_HOLD_MINUTES` | `1440` | Max hold time in minutes. |
| `TRADING_SLIPPAGE_BPS` | `100` | Slippage tolerance in bps (clamped 1..500). |
| `TRADING_MONITOR_INTERVAL_SEC` | `60` | Position monitor cadence. |
| `TRADING_DEX` | `uniswap-v3` | DEX adapter name. |
| `TRADING_DB_PATH` | `./data/trading.db` | SQLite path for positions/trades. |

### Commands

REPL: `/positions`, `/trades`, `/trade-on`, `/trade-off`, `/trade-status`,
`/sell <0xAddress>`.

Telegram (underscore variants): `/positions`, `/trades`, `/trade_on`,
`/trade_off`, `/trade_status`, `/sell <0xAddress>`.

### Storage

Positions and trades are persisted to a separate SQLite DB
(`./data/trading.db` by default). The watchlist DB is untouched. The
trading DB is in `.gitignore` along with all other `*.db*` files.

### Safety invariants

- Engine refuses to send a transaction unless `TRADING_LIVE=1`.
- Engine refuses new entries when `MAX_OPEN_POSITIONS` is reached or wallet
  USDC balance is below the entry size.
- All addresses go through the same `0x[0-9a-fA-F]{40}` regex and viem
  checksum that the rest of the agent uses.
- Slippage is enforced via `amountOutMinimum` derived from the Quoter.
- `/trade-off` immediately disables further entries; existing positions
  continue to be monitored and exited per policy.

## What it does

1. Loads a viem wallet from `PRIVATE_KEY` on Base mainnet.
2. Wraps `fetch` with `@x402/fetch` + `ExactEvmScheme` so 402 challenges are signed and retried automatically.
3. Spins up a Gemini chat with four function-calling tools — one per paid oracle endpoint.
4. Each tool call: validates address → calls the oracle → decodes the `X-PAYMENT-RESPONSE` settle receipt → validates the JSON with Zod → returns the data to Gemini for natural-language summary.

## Quick start

```bash
git clone <this repo>
cd svm402-agent
cp .env.example .env
# edit .env — set PRIVATE_KEY, GEMINI_API_KEY, ORACLE_URL
npm install
npm run build
npm start
```

Example session:

```
╭──────────────────────────────── 0xAbCd…1234 ╮
│ svm402-agent                                │
│ Gemini × x402 client for /report endpoint        │
│ ⚠  signs REAL USDC payments on Base (8453)  │
│                                             │
│ oracle    https://svm402.com                │
│ wallet    0xAbCdEf…1234                     │
│ balance   1.234567 USDC                     │
│ model     gemini-3.1-flash-lite-preview      │
│ spend cap $0.100 USDC / session             │
╰─────────────────────────────────────────────╯
  Type /help for commands. Ctrl-C or /quit to exit.

[$0.0000 / $0.100 • 0 calls] svm402❯ Tell me about 0x4200000000000000000000000000000000000006
⚡ get_report(0x4200…0006) … signing & settling on Base
✓ get_report  →  top-10 4.2% · 312,104 holders  •  $0.010 USDC  •  tx 0xabc123…def4
🤖  WETH on Base — verified ERC-20, 312,104 holders, top-10 concentration 4.2%…

[$0.0100 / $0.100 • 1 call] svm402❯ /spend
session spend  ██░░░░░░░░░░░░░░░░░░░░░░  $0.0100 / $0.100  (10%)

[$0.0100 / $0.100 • 1 call] svm402❯ /quit
bye.
```

## Configuration

| Var | Required | Default | Notes |
|---|---|---|---|
| `ORACLE_URL` | no | `https://svm402.com` | Base URL of a running base-token-oracle |
| `PRIVATE_KEY` | **yes** | — | 0x-prefixed 32-byte hex; wallet must hold USDC on Base |
| `GEMINI_API_KEY` | **yes** | — | from [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite-preview` | preview model; also fine: `gemini-2.5-flash`, `gemini-2.5-pro` |
| `MAX_SPEND_USDC` | no | `0.10` | Hard cap on cumulative session spend |
| `DEBUG` | no | `0` | `1` for verbose logs |
| `DISABLE_X402` | no | `0` | `1` disables x402 payment wrapper (useful with DEBUG=1) |
| `NO_COLOR` | no | unset | Standard env var; disables all colors when set |
| `SVM402_ASCII` | no | `0` | `1` falls back to plain ASCII glyphs/borders (for picky terminals) |
| `SVM402_PROMPT` | no | `rich` | `plain` falls back to `svm402> ` prompt |
| `SVM402_NO_SPINNER` | no | `0` | `1` disables in-flight spinners (useful when piping output) |

Colors and spinners auto-disable when stdout is not a TTY (e.g., piped to `tee`), so logs stay clean.

## Funding the wallet

You only need a few cents of USDC on Base. Easiest paths:

- Bridge USDC into Base via [bridge.base.org](https://bridge.base.org).
- Buy USDC directly on Base (most CEXes support Base withdrawals).
- For the agent's wallet address: launch the app once, copy the address from the banner, then send USDC to it.

`/report` (the primary tool) costs $0.01 USDC. The default session cap of $0.10 lets you run several real calls before the safety rail trips.

## Slash commands

Available in both the CLI REPL and the Telegram bot (unless noted):

- `/help` — list commands and tools
- `/balance` — show wallet address + USDC balance on Base
- `/spend` — total USDC spent this session
- `/receipts` — list all settled payment receipts
- `/watchlist` — show the curated watchlist (full contract addresses)
- `/scan` — run a watchlist scheduler tick on demand
- `/scheduler on|off` — toggle the periodic scanner (no arg shows status)
- `/clear` — reset chat history
- `/quit`, `/exit` — leave the REPL (CLI only)

## Scripts

- `npm run build` — compile to `dist/`
- `npm run dev` — `tsx watch` against `src/index.ts`
- `npm start` — run the compiled REPL
- `npm test` — vitest (no real payments; mocked fetch)
- `npm run lint` — eslint

## Architecture

```
.env  →  src/index.ts  →  REPL  →  Gemini chat (function-calling)
                                         │
                          functionCalls  ▼
                          src/oracle/handlers.ts
                                         │
                                         ▼
                          @x402/fetch  →  base-token-oracle
                          @x402/evm        signs USDC transferWithAuthorization
                          viem wallet
```

## Troubleshooting

### `400 INVALID_ARGUMENT: Function call is missing a thought_signature`

Gemini 2.5 / 3.x thinking models attach a `thoughtSignature` to every `functionCall` part. The signature must round-trip back to the API verbatim with the next `functionResponse`, otherwise the request fails strict validation. This requires `@google/genai >= 1.x` (the v0.x `Chat` helper drops signatures during history curation).

If you see this error, run `npm install` to make sure you're on the lockfile's pinned SDK version. See [Gemini docs on thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).

## Caveats

- Address-only pricing — Gemini cannot hit arbitrary URLs; only the four declared tools.
- The spend cap is **client-side**. It guards against runaway tool loops in this CLI; it does not stop another client from spending.
- Receipts are kept in memory only; not persisted to disk.
- Schema validation is `.passthrough()` so the client tolerates oracle additions without breaking.

## License

MIT
