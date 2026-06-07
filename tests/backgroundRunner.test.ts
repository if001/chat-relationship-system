import assert from "node:assert/strict";
import { test } from "vitest";
import { createRelationshipBackgroundRunner } from "../src/relationship_system/api/backgroundRunner";

const testBackgroundRunnerDispatchesForEachThread = async (): Promise<void> => {
  const calls: string[] = [];
  const runner = createRelationshipBackgroundRunner(
    {
      dispatchTasks: async ({ botId, threadId }) => {
        calls.push(`${botId}:${threadId}`);
        return [];
      },
    },
    {
      botId: "ao",
      threadIds: ["thread-a", "thread-b"],
    },
  );

  await runner.runOnce();

  assert.deepEqual(calls, ["ao:thread-a", "ao:thread-b"]);
};

const testBackgroundRunnerSkipsWhenShouldRunIsFalse = async (): Promise<void> => {
  const calls: string[] = [];
  const runner = createRelationshipBackgroundRunner(
    {
      dispatchTasks: async ({ botId, threadId }) => {
        calls.push(`${botId}:${threadId}`);
        return [];
      },
    },
    {
      botId: "ao",
      threadIds: ["thread-a"],
      shouldRun: async () => false,
    },
  );

  await runner.runOnce();

  assert.deepEqual(calls, []);
};

test("background runner dispatches for each thread", testBackgroundRunnerDispatchesForEachThread);
test("background runner skips when shouldRun is false", testBackgroundRunnerSkipsWhenShouldRunIsFalse);
