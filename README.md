# svm402-agent

> Gemini-driven agent that exercises the [base-token-oracle](https://github.com/dchu3/base-token-oracle) x402 payment flow against Base mainnet via CLI or Telegram.

An interactive agent where you chat in natural language about Base ERC-20 tokens. Gemini decides which oracle endpoint to call (`/report`), and the client signs a real USDC `transferWithAuthorization` per call via x402 v2.

> **⚠️ Real money.** Every successful tool call settles real USDC on Base mainnet (chainId 8453). Use the `MAX_SPEND_USDC` cap.

## Features

- **CLI REPL:** Rich terminal interface with spinners, tables, and a real-time spend bar.
- **Telegram Bot:** A private, authenticated bot interface to chat with the agent on the go.
- **x402 Payments:** Automatic signing and settlement of micro-payments for oracle reports.
- **Gemini Powered:** Natural language analysis of token safety, risk scores, and market data.

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

The agent includes a built-in Telegram bot. To enable it:
1. Create a bot via [@BotFather](https://t.me/botfather) and get the `TELEGRAM_BOT_TOKEN`.
2. Get your numeric Telegram User ID (e.g. via [@userinfobot](https://t.me/userinfobot)).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` in your `.env`.
4. Run `npm start`. If the token is present, the agent launches the bot instead of the REPL.

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
| `NO_COLOR` | no | unset | Standard env var; disables all colors when set |
| `SVM402_ASCII` | no | `0` | `1` falls back to plain ASCII glyphs/borders (for picky terminals) |
| `SVM402_PROMPT` | no | `rich` | `plain` falls back to `svm402> ` prompt |
| `SVM402_NO_SPINNER` | no | `0` | `1` disables in-flight spinners (useful when piping output) |

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

[$0.0000 / $0.100 • 0 calls] svm402❯ Is 0x4200000000000000000000000000000000000006 safe?
⚡ get_report(0x4200…0006) … signing & settling on Base
✓ get_report  →  risk 0/10 · clean  •  $0.010 USDC  •  tx 0xabc123…def4
🤖  WETH on Base looks clean — risk score 0/10. Liquidity ~$8.4M…

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

- `/help` — list commands and tools
- `/balance` — show wallet address + USDC balance on Base
- `/spend` — total USDC spent this session
- `/receipts` — list all settled payment receipts
- `/clear` — reset chat history
- `/quit`, `/exit` — leave the REPL

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
