import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFileCachedRelationshipPlanningModel } from "../src/relationship_system/infrastructure/ollama/fileCachedModel";
import { RelationshipPlanningModel } from "../src/relationship_system/domain/types";

test("file cached planning model reuses cached result for identical prompts", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "relationship-llm-cache-"));
  let calls = 0;
  const inner: RelationshipPlanningModel = {
    generateJson: async () => {
      calls += 1;
      return { value: "cached-result" };
    },
  };
  const model = createFileCachedRelationshipPlanningModel(inner, { cacheDir });

  const first = await model.generateJson<{ value: string }>("system", "user");
  const second = await model.generateJson<{ value: string }>("system", "user");

  assert.deepEqual(first, { value: "cached-result" });
  assert.deepEqual(second, { value: "cached-result" });
  assert.equal(calls, 1);
});

test("file cached planning model recomputes when ttl expires", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "relationship-llm-cache-"));
  let calls = 0;
  const inner: RelationshipPlanningModel = {
    generateJson: async () => {
      calls += 1;
      return { call: calls };
    },
  };
  const model = createFileCachedRelationshipPlanningModel(inner, {
    cacheDir,
    ttlMs: 1,
  });

  const first = await model.generateJson<{ call: number }>("system", "user");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await model.generateJson<{ call: number }>("system", "user");

  assert.deepEqual(first, { call: 1 });
  assert.deepEqual(second, { call: 2 });
  assert.equal(calls, 2);
});
