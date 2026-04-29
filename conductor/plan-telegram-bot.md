# Telegram Bot Integration Plan

## Objective
Integrate a Telegram bot that allows users to chat with the existing `svm402` agent. The bot will be strictly private, only responding to an authorized user ID.

## Scope & Impact
- Add the `telegraf` dependency.
- Introduce new environment variables: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`.
- Create a new module `src/telegram.ts`.
- Implementation will take place on a new branch `feat/telegram-bot`.
- Ensure no sensitive data (keys, tokens, etc.) is included in code or commits.

## Proposed Solution

1. **Branch Management:**
   - Create and switch to a new branch: `feat/telegram-bot`.

2. **Environment Configuration:**
   - Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` to `.env.example`.
   - In `src/index.ts`, check for these variables.

3. **Privacy Enforcement:**
   - The bot will implement a middleware or a check on each incoming message to ensure the `message.from.id` matches the `TELEGRAM_ALLOWED_USER_ID`. If not, it will ignore the message or send a "unauthorized" reply.

4. **Telegram Module (`src/telegram.ts`):**
   - Create `startTelegramBot(deps: { agent: Agent, token: string, allowedUserId: number })`.
   - Initialize `Telegraf`.
   - Implement authorization middleware.
   - Handle `/start`, `/clear`, and text messages by forwarding to `agent.send()`.
   - Use hooks for status updates during tool execution.

5. **Security & Audit:**
   - Before completing the task, perform a thorough review of the changes to ensure no sensitive credentials have been hardcoded or logged.

## Implementation Steps
1. Create branch `feat/telegram-bot`.
2. Install `telegraf`.
3. Create `src/telegram.ts` with privacy checks.
4. Update `src/index.ts` to wire up the bot.
5. Update `.env.example`.
6. Audit for sensitive data.

## Verification
- Run with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`.
- Verify bot only responds to the authorized user.
- Verify report generation works as expected.