import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRelationshipPolicyStateStore } from "../src/relationship_system/infrastructure/filePolicyStateStore";

const run = async (): Promise<void> => {
  await testFilePolicyStateStoreSavesAndLoads();
};

const testFilePolicyStateStoreSavesAndLoads = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "relationship-policy-"));
  try {
    const store = createFileRelationshipPolicyStateStore({ baseDir: dir });
    await store.savePolicyState({
      botId: "ao",
      threadId: "thread-1",
      summary: "The user prefers fewer feedback questions.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: true,
      preferConcisePrompts: true,
      proactiveInfoPreference: "avoid",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    });

    const loaded = await store.getPolicyState({
      botId: "ao",
      threadId: "thread-1",
    });

    assert.equal(loaded?.avoidFeedbackQuestions, true);
    assert.equal(loaded?.preferConcisePrompts, true);
    assert.equal(loaded?.proactiveInfoPreference, "avoid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

void run();
