import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { createRelationshipBackgroundApp } from "../src/relationship_system/api/backgroundApp";
import {
  createFileQueueBackgroundInputSink,
  createFileRelationshipPolicyStateStore,
  createFileRelationshipTurnRecordStore,
  createFileRelationshipWorkUnitStateStore,
} from "../src";

test("backgroundApp runner enqueues a user-facing intervention", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "relationship-bg-app-"));
  const queuePath = join(baseDir, "queue.json");

  const app = createRelationshipBackgroundApp({
    botId: "ao",
    threadIds: ["thread-1"],
    pollMs: 10_000,
    turnRecordStore: createFileRelationshipTurnRecordStore({
      baseDir,
      maxTurnsPerThread: 50,
    }),
    policyStateStore: createFileRelationshipPolicyStateStore({ baseDir }),
    workUnitStateStore: createFileRelationshipWorkUnitStateStore({ baseDir }),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          clarificationCandidates: ["Unknown preference."],
          proactiveContextCandidates: [],
          repairCandidates: [],
          boundaryCandidates: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: createFileQueueBackgroundInputSink({
      filePath: queuePath,
      channelId: "channel-1",
    }),
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  await app.runner.runOnce();

  const raw = await readFile(queuePath, "utf8");
  const tasks = JSON.parse(raw) as Array<{ action: string; text: string }>;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.action, "agent_input");
  assert.match(tasks[0]?.text ?? "", /確認です。/);
});
