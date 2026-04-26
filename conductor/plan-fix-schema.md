# Objective
Fix the schema validation failure on the `/report` endpoint by making the `risk` property optional.

# Key Files & Context
- `src/oracle/schemas.ts`: Contains the Zod schemas for endpoint responses.

# Implementation Steps
1. Open `src/oracle/schemas.ts`.
2. Update the `ReportResponseSchema` so that the `risk` property uses `.optional()`, since the API does not always return a `risk` object for every token.

# Verification & Testing
1. **Compilation:** Run `npx tsc --noEmit` to verify type checking still passes.
2. **Testing:** Run `npm test` or `npx vitest run` to ensure all tests pass without errors.