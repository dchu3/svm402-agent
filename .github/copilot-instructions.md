# Copilot Instructions for svm402-agent

## Build, Test, and Lint

- **Build**: `npm run build` — Compiles TypeScript to `dist/`
- **Dev mode**: `npm run dev` — Runs `tsx watch` on `src/index.ts` for rapid development
- **Start**: `npm start` — Runs the compiled REPL from `dist/index.js`
- **Test**: `npm test` — Runs vitest suite (tests are in `tests/**/*.test.ts`)
  - Run a single test file: `npm test -- tests/tools.test.ts`
  - Run tests matching a pattern: `npm test -- -t "TOOL_DECLARATIONS"`
- **Lint**: `npm run lint` — Runs eslint on `src/**/*.ts` and `tests/**/*.ts`

## High-Level Architecture

This is a Gemini-powered CLI agent that analyzes ERC-20 tokens on Base mainnet (chainId 8453) via paid oracle endpoints. The flow is:

1. **Entry point** (`src/index.ts`): Checks presence of required environment variables (PRIVATE_KEY, GEMINI_API_KEY) and initializes the wallet, oracle client, spend tracker, and Gemini agent. Shows a banner with wallet address, model, and spend cap. Format validation of PRIVATE_KEY is deferred to `createWallet()` in `src/wallet.ts`.

2. **Wallet** (`src/wallet.ts`): Creates a viem wallet from PRIVATE_KEY and provides a method to check USDC balance on Base using the public client.

3. **Agent** (`src/agent.ts`): Sets up a Gemini chat with a system instruction and four function-calling tools. The `send()` method forwards user messages to Gemini, intercepts function calls, routes them to handlers, and continues the conversation until Gemini produces final text.

4. **Oracle client** (`src/oracle/client.ts`): Wraps fetch with `@x402/fetch` + `ExactEvmScheme` to automatically sign and retry HTTP 402 challenges. Tracks payment receipts (endpoint, success, transaction hash, network, atomic amount).

5. **Handlers** (`src/oracle/handlers.ts`): Implements the four tool handlers (`get_market`, `get_honeypot`, `get_forensics`, `get_report`). Each handler validates the token address, checks the spend cap, calls the oracle, validates the response with Zod, and returns a result.

6. **Tools** (`src/oracle/tools.ts`): Declares the four Gemini function-calling tools with their parameters and descriptions.

7. **Schemas** (`src/oracle/schemas.ts`): Zod schemas for oracle responses. All schemas use `.passthrough()` so the client tolerates oracle additions without breaking.

8. **REPL** (`src/repl.ts`): Interactive readline loop that handles slash commands (`/help`, `/balance`, `/spend`, `/receipts`, `/clear`, `/quit`) and forwards user input to the agent.

**Key invariant**: The spend tracker is checked *before* each API call. When the cap would be exceeded, the tool returns `spend_cap_exceeded` and the call is not made. This is a client-side safety rail, not enforced by the server.

## Key Conventions

### Environment variables
- `PRIVATE_KEY` (required): 64 hex characters (32 bytes); 0x prefix is optional and will be auto-added if missing. Format validation occurs in `src/wallet.ts`.
- `GEMINI_API_KEY` (required): From [aistudio.google.com](https://aistudio.google.com/app/apikey)
- `ORACLE_URL` (default `https://svm402.com`): Base URL of a running base-token-oracle
- `GEMINI_MODEL` (default `gemini-3.1-flash-lite-preview`): Model variant
- `MAX_SPEND_USDC` (default `0.10`): Hard cap on cumulative session spend
- `DEBUG` (default `0`): Set to `1` for verbose logging via `debug()` calls

### Address validation
- Addresses must be 0x-prefixed 40 hex characters (160 bits, standard Ethereum format)
- Validation is case-insensitive; all addresses are normalized to lowercase before API calls
- Regex: `/^0x[0-9a-fA-F]{40}$/i` (used in `validateAddress()` and `handlers.ts`)

### Tool pricing
Defined in `TOOL_PRICES_USD` and checked before every call:
- `get_market`: $0.005
- `get_honeypot`: $0.010
- `get_forensics`: $0.020
- `get_report`: $0.030

### Zod schema patterns
- Top-level response schemas use `.passthrough()` to allow oracle API evolution without breaking the client. Note: `TopPoolSchema` (nested inside `MarketResponseSchema`) does not use `.passthrough()`, so added fields within `top_pool` will cause schema validation to fail.
- Responses are first passed through `schema.safeParse()` to validate known fields; if parsing fails, the raw data is still returned with `ok: true`
- This tolerates oracle additions at the top level and makes the client defensive against unexpected fields

### Error handling in handlers
- Invalid address → `{ ok: false, error: 'invalid_address' }`
- Spend cap exceeded → `{ ok: false, error: 'spend_cap_exceeded: ...' }`
- Fetch/network error → `{ ok: false, error: '<error message>' }`
- Schema validation failure → `{ ok: true, data: <raw data> }` (data is still useful)

### Agent behavior
- The agent has a 6-hop safety limit on tool calls to prevent infinite loops
- After each tool call, the agent receives structured responses and produces natural-language summaries
- The system instruction directs Gemini to prefer `get_report` for "is this token safe?" questions and to always call tools rather than guess

### Payment receipts
- Stored in-memory in `OracleClient.receipts` as an array of `Receipt` objects
- Not persisted to disk; cleared when the process exits
- Each receipt records:
  - `endpoint`: Oracle endpoint path (e.g., `/api/v1/x402/base/token/.../market`)
  - `success`: Boolean indicating if the HTTP request succeeded
  - `transaction`: Transaction hash on the blockchain (for settled payments)
  - `network`: Network identifier (e.g., `eip155:8453`)
  - `payer` (optional): Address of the payer
  - `amountAtomic` (optional): Amount settled in atomic units
  - `errorReason` (optional): Error description when `success: false`

### Testing patterns
- Tests mock the oracle and spend tracker; no real payments are made
- Test files use vitest and include tool declaration validation, address validation, and schema checks
- Example: `tests/tools.test.ts` verifies that all declared tools have prices and require an address parameter
