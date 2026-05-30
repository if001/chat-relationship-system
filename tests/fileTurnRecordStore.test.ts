import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRelationshipTurnRecordStore } from "../src/relationship_system/infrastructure/fileTurnRecordStore";

const run = async (): Promise<void> => {
  await testFileTurnRecordStoreAppendsAndListsRecentTurns();
};

const testFileTurnRecordStoreAppendsAndListsRecentTurns = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "relationship-store-"));
  try {
    const store = createFileRelationshipTurnRecordStore({
      baseDir: dir,
      maxTurnsPerThread: 2,
    });

    await store.appendTurnRecord({
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [
        {
          role: "user",
          content: "one",
          timestampIso: "2026-05-29T00:00:00.000Z",
        },
      ],
    });
    await store.appendTurnRecord({
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:01:00.000Z",
      messages: [
        {
          role: "user",
          content: "two",
          timestampIso: "2026-05-29T00:01:00.000Z",
        },
      ],
    });
    await store.appendTurnRecord({
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:02:00.000Z",
      messages: [
        {
          role: "user",
          content: "three",
          timestampIso: "2026-05-29T00:02:00.000Z",
        },
      ],
    });

    const result = await store.listRecentTurnRecords({
      botId: "ao",
      threadId: "thread-1",
      limit: 5,
    });

    assert.equal(result.length, 2);
    assert.equal(result[0]?.messages[0]?.content, "two");
    assert.equal(result[1]?.messages[0]?.content, "three");
    assert.match(result[0]?.id ?? "", /^rel_turn_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

void run();
