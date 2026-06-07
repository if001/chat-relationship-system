import assert from "node:assert/strict";
import { test } from "vitest";
import {
  learnInterventionPolicyStateWithLlm,
  learnPreferredExecutionModeWithLlm,
} from "../src/relationship_system/api/llmPolicyLearning";
import {
  RelationshipInterventionPolicyState,
  RelationshipPlanningModel,
  TurnRecord,
} from "../src/relationship_system/domain/types";

test("learnInterventionPolicyStateWithLlm explains schema and passes minimal fields", async () => {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async (systemPrompt, userPrompt) => {
      calls.push({ systemPrompt, userPrompt });
      return {
        summary: "Ask fewer feedback questions and prefer concise proactive notes.",
        interventionFocus: "relationship",
        preferredExecutionMode: "provide_info",
        avoidFeedbackQuestions: true,
        preferConcisePrompts: true,
        proactiveInfoPreference: "allow",
      };
    },
  };

  const result = await learnInterventionPolicyStateWithLlm(
    {
      botId: "ao",
      threadId: "thread-1",
      report: {
        clarificationCandidates: ["Unknown preference."],
        proactiveContextCandidates: ["Policy card is stale: pc-1"],
        repairCandidates: [],
        boundaryCandidates: [],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
      recentContextSummary: "unused summary",
    },
    recentTurns(),
    currentPolicyState(),
    plannerModel,
  );

  assert.equal(result?.interventionFocus, "relationship");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemPrompt, /relationshipInsightReport は relationship-support の機会を要約したものです/);
  assert.match(calls[0]!.systemPrompt, /interventionFocus は厳密に relationship, memory, balanced から選んでください/);
  assert.match(calls[0]!.userPrompt, /"relationshipInsightReport":/);
  assert.match(calls[0]!.userPrompt, /"currentPolicyState":/);
  assert.match(calls[0]!.userPrompt, /"recentTurns":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"botId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"threadId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"updatedAtIso":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"recentContextSummary":/);
});

test("learnPreferredExecutionModeWithLlm explains schema and passes minimal fields", async () => {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async (systemPrompt, userPrompt) => {
      calls.push({ systemPrompt, userPrompt });
      return { preferredExecutionMode: "ask_user" };
    },
  };

  const result = await learnPreferredExecutionModeWithLlm(
    recentTurns(),
    currentPolicyState(),
    plannerModel,
  );

  assert.equal(result, "ask_user");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemPrompt, /preferredExecutionMode は厳密に ask_user, collect_info, provide_info, balanced から選んでください/);
  assert.match(calls[0]!.userPrompt, /"currentPolicyState":/);
  assert.match(calls[0]!.userPrompt, /"recentTurns":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"botId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"threadId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"updatedAtIso":/);
});

test("learnInterventionPolicyStateWithLlm returns null without calling LLM when no update signals exist", async () => {
  let called = false;
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => {
      called = true;
      return {};
    },
  };

  const result = await learnInterventionPolicyStateWithLlm(
    {
      botId: "ao",
      threadId: "thread-1",
      report: {
        clarificationCandidates: [],
        proactiveContextCandidates: [],
        repairCandidates: [],
        boundaryCandidates: [],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
    },
    [
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解です。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ],
    currentPolicyState(),
    plannerModel,
  );

  assert.equal(result, null);
  assert.equal(called, false);
});

test("learnPreferredExecutionModeWithLlm returns explicit preference without calling LLM", async () => {
  let called = false;
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => {
      called = true;
      return { preferredExecutionMode: "balanced" };
    },
  };

  const result = await learnPreferredExecutionModeWithLlm(
    [
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "確認してもらえると助かります。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ],
    currentPolicyState(),
    plannerModel,
  );

  assert.equal(result, "ask_user");
  assert.equal(called, false);
});

const recentTurns = (): TurnRecord[] => [
  {
    botId: "ao",
    threadId: "thread-1",
    createdAtIso: "2026-05-29T00:00:00.000Z",
    messages: [
      {
        role: "assistant",
        content: "最近の確認頻度はどうですか。",
        timestampIso: "2026-05-29T00:00:00.000Z",
      },
      {
        role: "user",
        content: "少し多いです。短めだと助かります。",
        timestampIso: "2026-05-29T00:01:00.000Z",
      },
    ],
  },
];

const currentPolicyState = (): RelationshipInterventionPolicyState => ({
  botId: "ao",
  threadId: "thread-1",
  summary: "Balanced with occasional proactive help.",
  interventionFocus: "balanced",
  preferredExecutionMode: "balanced",
  avoidFeedbackQuestions: false,
  preferConcisePrompts: false,
  proactiveInfoPreference: "unknown",
  updatedAtIso: "2026-05-29T00:00:00.000Z",
});
