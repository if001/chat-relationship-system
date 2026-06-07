import assert from "node:assert/strict";
import { test } from "vitest";
import { createRelationshipSystemService } from "../src/relationship_system/api/service";
import {
  RelationshipInterventionPolicyState,
  RelationshipPolicyStateStore,
  RelationshipTurnRecordStore,
  RelationshipWorkUnitStateStore,
  TurnRecord,
} from "../src/relationship_system/domain/types";

test("replay: organize intervene observe adjust sequence closes one work unit", async () => {
  const queue: Array<{ step?: string; text: string }> = [];
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  const turnStore = createInMemoryTurnRecordStore();
  const policyStore = createInMemoryPolicyStateStore();
  const workUnitStore = createInMemoryWorkUnitStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: turnStore,
    policyStateStore: policyStore,
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          clarificationCandidates: [],
          proactiveContextCandidates: ["Policy card is stale: pc-1"],
          repairCandidates: [],
          boundaryCandidates: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        queue.push({ step: input.sourceUnitStep, text: input.text });
      },
    },
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(first[0]?.sourceUnitStep, "intervene");

  await turnStore.appendTurnRecord({
    botId: "ao",
    threadId: "thread-1",
    createdAtIso: "2026-05-29T00:00:00.000Z",
    messages: [{ role: "assistant", content: first[0]?.text ?? "", timestampIso: "2026-05-29T00:00:00.000Z" }],
  });

  currentTime = new Date("2026-05-29T00:20:00.000Z");
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(second[0]?.sourceUnitStep, "observe");

  await service.ingestTurnRecord({
    botId: "ao",
    threadId: "thread-1",
    createdAtIso: "2026-05-29T00:21:00.000Z",
    messages: [{ role: "user", content: "少し多いです。", timestampIso: "2026-05-29T00:21:00.000Z" }],
  });

  const units = await workUnitStore.listWorkUnits({ botId: "ao", threadId: "thread-1" });
  assert.equal(units[0]?.currentStep, "adjust");
  assert.equal(units[0]?.status, "response_received");
  assert.equal(queue.length, 2);
});

test("replay: no-signal observation suppresses repeated observe dispatch", async () => {
  const turnStore = createInMemoryTurnRecordStore([
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [{ role: "assistant", content: "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。", timestampIso: "2026-05-29T00:00:00.000Z" }],
    },
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:01:00.000Z",
      messages: [{ role: "assistant", content: "了解です。", timestampIso: "2026-05-29T00:01:00.000Z" }],
    },
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:02:00.000Z",
      messages: [{ role: "assistant", content: "補足です。", timestampIso: "2026-05-29T00:02:00.000Z" }],
    },
  ]);
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: "unit_ao_thread-1_stale_context_Policy_card_is_stale__pc-1",
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "observe",
      status: "waiting_for_response",
      sourceSignals: ["Policy card is stale: pc-1"],
      lastInterventionAtIso: "2026-05-29T00:00:00.000Z",
      lastObservationPrompt: "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。",
      responseWindowTurns: 2,
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: turnStore,
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          clarificationCandidates: [],
          proactiveContextCandidates: ["Policy card is stale: pc-1"],
          repairCandidates: [],
          boundaryCandidates: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: { enqueue: async () => {} },
  });

  await service.ingestTurnRecord({
    botId: "ao",
    threadId: "thread-1",
    createdAtIso: "2026-05-29T00:03:00.000Z",
    messages: [{ role: "assistant", content: "次へ進みます。", timestampIso: "2026-05-29T00:03:00.000Z" }],
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks.length, 0);
});

function createInMemoryTurnRecordStore(initial: TurnRecord[] = []): RelationshipTurnRecordStore {
  const items = [...initial];
  return {
    appendTurnRecord: async (turn) => {
      items.push(turn);
    },
    listRecentTurnRecords: async ({ botId, threadId, limit }) =>
      items.filter((turn) => turn.botId === botId && turn.threadId === threadId).slice(-limit),
  };
}

function createInMemoryPolicyStateStore(
  initial: RelationshipInterventionPolicyState | null = null,
): RelationshipPolicyStateStore {
  const items = new Map<string, RelationshipInterventionPolicyState>();
  if (initial) {
    items.set(`${initial.botId}:${initial.threadId}`, initial);
  }
  return {
    getPolicyState: async ({ botId, threadId }) => items.get(`${botId}:${threadId}`) ?? null,
    savePolicyState: async (state) => {
      items.set(`${state.botId}:${state.threadId}`, state);
    },
  };
}

function createInMemoryWorkUnitStateStore(initial: any[] = []): RelationshipWorkUnitStateStore {
  const items = new Map<string, any[]>();
  for (const state of initial) {
    const key = `${state.botId}:${state.threadId}`;
    const current = items.get(key) ?? [];
    current.push(state);
    items.set(key, current);
  }
  return {
    listWorkUnits: async ({ botId, threadId }) => items.get(`${botId}:${threadId}`) ?? [],
    saveWorkUnit: async (state) => {
      const key = `${state.botId}:${state.threadId}`;
      const current = items.get(key) ?? [];
      const next = current.filter((item) => item.unitId !== state.unitId);
      next.push(state);
      items.set(key, next);
    },
  };
}
