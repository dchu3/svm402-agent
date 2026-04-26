# Objective
Remove all `x402` endpoint references apart from `/report` (`get_market`, `get_honeypot`, `get_forensics`), and ensure no sensitive data is introduced before pushing.

# Key Files & Context
- `src/oracle/handlers.ts`: Contains API endpoint handlers.
- `src/oracle/tools.ts`: Contains Gemini tool declarations for endpoints.
- `src/oracle/schemas.ts`: Contains Zod schemas for endpoint responses.
- `tests/handlers.test.ts`: Contains tests for the endpoints.
- `tests/ui/ui.test.ts`: UI tests containing mock endpoint calls.
- `README.md`: Documentation referencing the endpoints.

# Implementation Steps
1. **Branch Management:** Create a new branch `remove-x402-endpoints`.
2. **Remove Handlers:**
   - In `src/oracle/handlers.ts`, remove `get_market`, `get_honeypot`, and `get_forensics` from `TOOL_PRICES_USD` and `handlers` object.
   - Also remove their corresponding schema imports (`MarketResponseSchema`, `HoneypotResponseSchema`, `ForensicsResponseSchema`).
3. **Remove Tool Declarations:**
   - In `src/oracle/tools.ts`, remove the tool definitions for `get_market`, `get_honeypot`, and `get_forensics` from `TOOL_DECLARATIONS`.
4. **Remove Schemas:**
   - In `src/oracle/schemas.ts`, remove `MarketResponseSchema`, `HoneypotResponseSchema`, and `ForensicsResponseSchema`.
5. **Update Tests:**
   - In `tests/handlers.test.ts`, remove tests related to the deleted endpoints.
   - In `tests/ui/ui.test.ts`, update mock responses and endpoints related to `/market`, `/honeypot`, and `/forensics`.
6. **Update Documentation:**
   - In `README.md`, remove mentions of `/market`, `/honeypot`, and `/forensics` endpoints, leaving only `/report`.

# Verification & Testing
1. **Compilation:** Run `npm run build` or `npx tsc --noEmit` to verify type checking passes after removing schemas and handlers.
2. **Testing:** Run `npm test` or `npx vitest run` to ensure all tests pass.
3. **Security Review:** Run `git diff HEAD` to manually inspect all changes and ensure no sensitive data (e.g., hardcoded API keys, PII) has been inadvertently exposed or introduced before staging any files.