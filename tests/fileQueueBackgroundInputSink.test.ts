import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import {
  createFileQueueBackgroundInputSink,
  getFileQueueStatus,
} from "../src/relationship_system/infrastructure/fileQueueBackgroundInputSink";

const testFileQueueBackgroundInputSinkEnqueuesAndSuppressesDuplicates = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "relationship-queue-"));
  const queuePath = join(dir, "queue.json");
  try {
    const sink = createFileQueueBackgroundInputSink({
      filePath: queuePath,
      channelId: "channel-1",
      enqueueCooldownMs: 3_600_000,
    });

    await sink.enqueue({
      botId: "ao",
      threadId: "thread-1",
      text: "follow up",
      sourceTaskId: "rel-task-1",
    });
    await sink.enqueue({
      botId: "ao",
      threadId: "thread-1",
      text: "follow up",
      sourceTaskId: "rel-task-1",
    });

    const status = await getFileQueueStatus(queuePath);
    assert.equal(status.counts.readyByType.scheduled_once, 1);
    assert.equal(status.counts.readyByType.user, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const testFileQueueBackgroundInputSinkWritesDebugLog = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "relationship-queue-log-"));
  const queuePath = join(dir, "queue.json");
  const logPath = join(dir, "queue-debug.jsonl");
  try {
    const sink = createFileQueueBackgroundInputSink({
      filePath: queuePath,
      channelId: "channel-1",
      enqueueCooldownMs: 3_600_000,
      debugLogFilePath: logPath,
    });

    await sink.enqueue({
      botId: "ao",
      threadId: "thread-1",
      text: "follow up",
      sourceTaskId: "rel-task-1",
      sourceUnitId: "unit-1",
      sourceUnitStep: "intervene",
    });
    await sink.enqueue({
      botId: "ao",
      threadId: "thread-1",
      text: "follow up",
      sourceTaskId: "rel-task-1",
      sourceUnitId: "unit-1",
      sourceUnitStep: "intervene",
    });

    const raw = await readFile(logPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string });
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.event),
      ["enqueued", "skipped_duplicate"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test(
  "file queue background input sink enqueues and suppresses duplicates",
  testFileQueueBackgroundInputSinkEnqueuesAndSuppressesDuplicates,
);
test(
  "file queue background input sink writes debug log",
  testFileQueueBackgroundInputSinkWritesDebugLog,
);
