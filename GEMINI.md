# svm402-agent Project Instructions

This project is a Gemini-driven agent that interacts with the `base-token-oracle` using the x402 payment flow on Base mainnet. It supports both a CLI REPL and a Telegram bot interface.

## Project Overview

- **Core Technology:** TypeScript, Node.js, Gemini AI (via `@google/genai`), x402 Payments (`@x402/fetch`, `@x402/evm`), Viem (for EVM interactions).
- **Architecture:**
  - `src/index.ts`: Application entry point. Handles configuration, wallet initialization, and starts either the REPL or Telegram bot.
  - `src/agent.ts`: Manages the Gemini chat session and function-calling logic.
  - `src/oracle/`: Client and handlers for interacting with the `base-token-oracle`.
  - `src/repl.ts`: CLI REPL implementation.
  - `src/telegram.ts`: Telegram bot implementation using `telegraf`.
  - `src/scheduler/`: Periodic scanning logic for trending tokens via DexScreener.
  - `src/watchlist/`: Local SQLite database for tracking high-quality tokens.
- **Key Features:** Natural language token analysis, real-time USDC micro-payments on Base, periodic trending token scans, and a secure Telegram interface.

## Building and Running

### Prerequisites
- Node.js (v20+ recommended)
- A `.env` file based on `.env.example` with `PRIVATE_KEY` (Base wallet) and `GEMINI_API_KEY`.

### Key Commands
- **Build:** `npm run build` (compiles TypeScript to `dist/`)
- **Development:** `npm run dev` (runs `tsx watch` for real-time development)
- **Start:** `npm start` (runs the compiled application from `dist/index.js`)
- **Test:** `npm test` (runs Vitest suites in `tests/`)
- **Lint:** `npm run lint` (runs ESLint on `src/` and `tests/`)

## Development Conventions

- **Module System:** Uses ES Modules (`"type": "module"` in `package.json`).
- **Type Safety:** Strict TypeScript usage. Ensure new code is properly typed.
- **Payments:** All oracle calls are wrapped in x402. Every tool call settles real USDC. Use `MAX_SPEND_USDC` in `.env` for safety during development.
- **Testing:** New features or bug fixes should include tests in the `tests/` directory. Use Vitest for unit and integration testing. Mock external network calls (fetch, oracle) in tests.
- **UI:** The project uses `ora` for spinners, `cli-table3` for tables, and `picocolors` for terminal styling. Adhere to the existing "rich" UI patterns.
- **Environment Variables:** Access environment variables through the helpers in `src/index.ts` or ensure they are properly documented in `.env.example`.
- **Error Handling:** Use the UI helpers (`printError`, `printWarn`, `printInfo` in `src/ui/render.ts`) for consistent user feedback.

## Configuration (Environment Variables)

| Variable | Description | Default |
| --- | --- | --- |
| `ORACLE_URL` | Base URL of the oracle service | `https://svm402.com` |
| `PRIVATE_KEY` | Hex-prefixed private key for payments | **Required** |
| `GEMINI_API_KEY` | Google Gemini API Key | **Required** |
| `MAX_SPEND_USDC` | Session spending cap in USDC | `0.10` |
| `GEMINI_MODEL` | Gemini model to use | `gemini-3.1-flash-lite-preview` |
| `SCHEDULER_ENABLED` | Enable trending scan (1=yes, 0=no) | `1` |
| `TELEGRAM_BOT_TOKEN` | Token for Telegram bot mode | Optional |
| `TELEGRAM_ALLOWED_USER_ID` | Authorized user ID for the bot | Optional |
