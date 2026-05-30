import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFileQueueBackgroundInputSink,
  getFileQueueStatus,
} from "../src/relationship_system/infrastructure/fileQueueBackgroundInputSink";

const run = async (): Promise<void> => {
  await testFileQueueBackgroundInputSinkEnqueuesAndSuppressesDuplicates();
};

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

void run();
