# Objective
Update the `get_report` endpoint documentation and system instructions so the agent correctly understands it provides a general "Token report" rather than a guaranteed "Composite report + risk score". Also, fix the `/receipts` command by fetching the updated `payment-response` HTTP header instead of only the legacy `x-payment-response`.

# Key Files & Context
- `src/oracle/tools.ts`: Defines the `get_report` tool description.
- `src/ui/tables.ts`: Displays the `/help` table description for `get_report`.
- `src/agent.ts`: Contains the `SYSTEM_INSTRUCTION` for the LLM.
- `src/oracle/client.ts`: Contains the `createOracleClient` logic handling `x-payment-response` headers.

# Implementation Steps
1. **Branch Management:** Create a new branch `fix-receipts-and-descriptions`.
2. **Update Tool Description:** In `src/oracle/tools.ts`, change the `get_report` description to correctly reflect that it returns a "Token report with optional risk score" and costs $0.01 USDC.
3. **Update UI Help Table:** In `src/ui/tables.ts`, change the `desc` for `get_report` from `"Composite report + risk score"` to `"Token report"`.
4. **Update System Instruction:** In `src/agent.ts`, rewrite lines in `SYSTEM_INSTRUCTION`:
   - Replace "four paid tools" with "one paid tool".
   - Replace "For general 'is this token safe?' questions, prefer get_report (one paid call, composite answer) over fanning out to multiple individual endpoints." with "Use get_report to answer token safety questions.".
   - Change "Always quote the numeric risk score from get_report when you have it." to mention the score is optional.
5. **Fix Receipts Extraction:** In `src/oracle/client.ts`, update `res.headers.get('x-payment-response')` to `res.headers.get('payment-response') || res.headers.get('x-payment-response')` to ensure the receipt data is correctly extracted into `deps.oracle.receipts`.

# Verification & Testing
1. **Type Checking:** Run `npx tsc --noEmit` to verify type safety.
2. **Unit Tests:** Run `npm test` or `npx vitest run` to ensure all tests pass (particularly `ui.test.ts` where we changed `desc`).
3. **Diff Validation:** Review the changes via `git diff` before making a commit.