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

Key runtime knobs:

- `RELATIONSHIP_RECENT_TURN_LIMIT`
  - short window for recent feedback summary and planning context
- `RELATIONSHIP_POLICY_LEARNING_TURN_LIMIT`
  - longer window for intervention policy learning
- `RELATIONSHIP_EXECUTION_MODE_LEARNING_TURN_LIMIT`
  - longest window for learning which execution mode is working best
