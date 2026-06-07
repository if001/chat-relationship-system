import assert from "node:assert/strict";
import { test } from "vitest";
import {
  observeFeedbackResponse,
  extractObservedFeedbackResponses,
} from "../src/relationship_system/api/observeAdjust";
import {
  RelationshipPlanningModel,
  RelationshipWorkUnitState,
  TurnRecord,
} from "../src/relationship_system/domain/types";

test("observeFeedbackResponse uses LLM branch to accept feedback replies", async () => {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async (systemPrompt, userPrompt) => {
      calls.push({ systemPrompt, userPrompt });
      return { isFeedbackResponse: true };
    },
  };
  const result = await observeFeedbackResponse(
    [
      userTurn("2026-05-29T00:01:00.000Z", "その件はあとで進めたいです"),
    ],
    waitingObserveUnit(),
    plannerModel,
  );

  assert.deepEqual(result, {
    kind: "response_received",
    responseText: "その件はあとで進めたいです",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemPrompt, /observationPrompt は、介入の頻度、量、スタイル、有用性について assistant が以前に行った質問です/);
  assert.match(calls[0]!.userPrompt, /"observationPrompt":/);
  assert.match(calls[0]!.userPrompt, /"userReply":/);
  assert.match(calls[0]!.userPrompt, /isFeedbackResponse/);
});

test("observeFeedbackResponse uses LLM branch to reject unrelated replies", async () => {
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => ({ isFeedbackResponse: false }),
  };
  const result = await observeFeedbackResponse(
    [
      userTurn("2026-05-29T00:01:00.000Z", "次の実装ですが"),
      userTurn("2026-05-29T00:02:00.000Z", "別件の相談です"),
    ],
    { ...waitingObserveUnit(), responseWindowTurns: 2 },
    plannerModel,
  );

  assert.deepEqual(result, { kind: "no_signal" });
});

test("observeFeedbackResponse returns from heuristic positive without calling LLM", async () => {
  let called = false;
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => {
      called = true;
      return { isFeedbackResponse: false };
    },
  };
  const result = await observeFeedbackResponse(
    [userTurn("2026-05-29T00:01:00.000Z", "少し多いです")],
    waitingObserveUnit(),
    plannerModel,
  );

  assert.deepEqual(result, {
    kind: "response_received",
    responseText: "少し多いです",
  });
  assert.equal(called, false);
});

test("extractObservedFeedbackResponses prefers direct work unit responses", () => {
  const responses = extractObservedFeedbackResponses(
    [
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "最近の確認頻度はちょうどよかったですか。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
          {
            role: "user",
            content: "会話内容を進めたいです",
            timestampIso: "2026-05-29T00:01:00.000Z",
          },
        ],
      },
    ],
    [
      {
        ...waitingObserveUnit(),
        currentStep: "adjust",
        status: "response_received",
        observedResponseText: "少し多いです",
      },
    ],
  );

  assert.deepEqual(responses, ["少し多いです"]);
});

const waitingObserveUnit = (): RelationshipWorkUnitState => ({
  unitId: "unit-1",
  botId: "ao",
  threadId: "thread-1",
  kind: "stale_context",
  title: "Refresh stale context",
  currentStep: "observe",
  status: "waiting_for_response",
  sourceSignals: ["Policy card is stale: pc-1"],
  lastInterventionAtIso: "2026-05-29T00:00:00.000Z",
  lastObservationPrompt:
    "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。",
  responseWindowTurns: 3,
  updatedAtIso: "2026-05-29T00:00:00.000Z",
});

const userTurn = (createdAtIso: string, content: string): TurnRecord => ({
  botId: "ao",
  threadId: "thread-1",
  createdAtIso,
  messages: [{ role: "user", content, timestampIso: createdAtIso }],
});
