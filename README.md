# @chat-agent/relationship-system

Relationship System package for:

- reading memory insights from a generic memory provider
- planning lightweight relationship-improvement tasks
- converting selected tasks into background inputs
- dispatching those inputs through a generic queue sink

## Current status

- package scaffold created
- generic memory and queue interfaces defined
- planner and runner implemented
- memory-system adapter implemented
- package-local background CLI implemented

## Local development

Installed via root `package.json` using a file dependency:

`"@chat-agent/relationship-system": "file:packages/relationship-system"`

Background runtime:

`tsx --env-file=.env.sample src/cli/runBackground.ts`

Test:

`npm test --prefix packages/relationship-system`

Coverage:

`npm run test:coverage --prefix packages/relationship-system`

HTML coverage report is written to `packages/relationship-system/coverage/`.

Key runtime knobs:

- `RELATIONSHIP_RECENT_TURN_LIMIT`
  - short window for recent feedback summary and planning context
- `RELATIONSHIP_POLICY_LEARNING_TURN_LIMIT`
  - longer window for intervention policy learning
- `RELATIONSHIP_EXECUTION_MODE_LEARNING_TURN_LIMIT`
  - longest window for learning which execution mode is working best
- `RELATIONSHIP_POLICY_SCOPE_MODE`
  - `thread` | `user` | `hybrid`
  - controls whether policy state is stored per-thread, per-user, or merged (user base + thread override)
  - production default: `thread`
- `RELATIONSHIP_USER_SCOPE_MISSING_USER_ID_MODE`
  - `fallback_thread` | `skip_user_scope`
  - behavior when policy scope needs user key but explicit user id is not available
  - production default: `fallback_thread`
- `RELATIONSHIP_DISPATCH_SUPPRESSION_WINDOW_MS`
  - suppresses repeated low-priority same-kind dispatches within a time window
- `RELATIONSHIP_MIN_TURN_AGE_MS_BEFORE_LOW_PRIORITY_DISPATCH`
  - suppresses low-priority dispatch right after recent user/assistant turns
- `RELATIONSHIP_QUEUE_DEBUG_LOG_FILE`
  - optional JSONL debug log path for queued/skipped background inputs
- `RELATIONSHIP_LLM_CACHE_DIR`
  - file cache directory for identical LLM prompt pairs
  - default: `<RELATIONSHIP_STORE_DIR>/llm-cache`
- `RELATIONSHIP_LLM_CACHE_TTL_MS`
  - cache TTL in milliseconds for LLM responses
  - default: `86400000` (24 hours)
