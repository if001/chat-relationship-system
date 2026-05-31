import assert from "node:assert/strict";
import {
  createRelationshipSystemService,
  planRelationshipTasks,
  planRelationshipTasksWithLlm,
} from "../src/relationship_system/api/service";
import {
  BackgroundInput,
  RelationshipInterventionPolicyState,
  RelationshipMemoryInsights,
  RelationshipPolicyStateStore,
  RelationshipTurnRecordStore,
  TurnRecord,
} from "../src/relationship_system/domain/types";

const run = async (): Promise<void> => {
  await testPlanRelationshipTasksCreatesExpectedTasks();
  await testPlanRelationshipTasksWithLlmUsesFeedbackAndMemoryImprovement();
  await testDispatchTasksEnqueuesLimitedBackgroundInputs();
  await testDispatchSuppressesWhenReportAndTaskAreUnchanged();
  await testDispatchSuppressesLowPrioritySameKindWithinWindow();
  await testDispatchDoesNotSuppressHighPriorityDuplicates();
  await testDispatchSuppressesLowPriorityWhenRecentTurnIsTooFresh();
  await testDispatchIncludesWorkUnitMetadata();
  await testDispatchDoesNotSuppressDifferentWorkUnitsWithinWindow();
  await testIngestTurnRecordAppendsToStore();
  await testPlanTasksUsesRecentTurnFeedbackSummary();
  await testPlanTasksUsesLlmFeedbackExtractionBeforePlanning();
  await testPolicyLearningSuppressesFeedbackQuestions();
  await testPolicyLearningAddsConcisePromptHint();
  await testHeuristicPlanningAddsMemoryImprovementTask();
  await testPolicyLearningPrefersMemoryInterventions();
  await testPolicyLearningSuppressesInfoGatheringWhenUserRejectsProactiveInfo();
  await testQuestionAvoidanceDeprioritizesAskUserTasks();
  await testConcisePreferenceAlsoShortensProvideInfoTasks();
  await testDetailedPreferenceRelaxesConcisePromptPolicy();
  await testProactiveInfoWelcomeRelaxesAvoidPolicy();
  await testFocusRemainsStableWithoutStrongNewSignal();
  await testPreferredExecutionModePersistsWithoutNewSignal();
  await testPreferredExecutionModeCanShiftToProvideInfo();
  await testPolicyLearningUsesLongerWindowThanRecentSummary();
  await testExecutionModeLearningUsesItsOwnLongerWindow();
  await testFocusTakesPriorityOverPreferredExecutionMode();
  await testAskUserSuppressionOverridesPreferredExecutionMode();
  await testUserScopeSharesPolicyAcrossThreads();
  await testHybridScopePrefersThreadOverride();
  await testUserScopeUsesExplicitUserIdResolver();
  await testUserScopeFallsBackToThreadWhenUserKeyMissing();
  await testUserScopeSkipsWhenUserKeyMissingAndSkipModeEnabled();
  await testHybridScopeMergesWithThreadFieldPriority();
};

const testPlanRelationshipTasksCreatesExpectedTasks = async (): Promise<void> => {
  const tasks = planRelationshipTasks(
    {
      botId: "ao",
      threadId: "thread-1",
      report: {
        gaps: ["The user's preferred proactive frequency is unknown."],
        staleNotes: ["Policy card is stale: pc-1"],
        conflicts: ["Conflicting recommended behavior detected for title: implementation support"],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
    },
    {
      proactiveHelpLevel: "medium",
      askForFeedbackSparingly: true,
      maxBackgroundInputsPerRun: 1,
    },
    new Date("2026-05-29T00:00:00.000Z"),
  );

  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["feedback_prepare", "info_gathering", "context_hint", "memory_improvement"],
  );
  assert.deepEqual(
    tasks.map((task) => task.executionMode),
    ["ask_user", "collect_info", "provide_info", "ask_user"],
  );
  assert.match(tasks[0]?.inputText ?? "", /clarification/);
};

const testDispatchTasksEnqueuesLimitedBackgroundInputs = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const insights: RelationshipMemoryInsights = {
    botId: "ao",
    threadId: "thread-1",
    report: {
      gaps: ["Unknown preference."],
      staleNotes: ["Policy card is stale: pc-1"],
      conflicts: [],
      createdAtIso: "2026-05-29T00:00:00.000Z",
    },
  };

  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => insights,
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
      proactiveHelpLevel: "high",
    },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const result = await service.dispatchTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(result.length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.sourceTaskId, result[0]?.sourceTaskId);
};

const testDispatchSuppressesWhenReportAndTaskAreUnchanged = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const insights: RelationshipMemoryInsights = {
    botId: "ao",
    threadId: "thread-1",
    report: {
      gaps: ["Unknown preference."],
      staleNotes: [],
      conflicts: [],
      createdAtIso: "2026-05-29T00:00:00.000Z",
    },
  };

  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => insights,
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
    },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(enqueued.length, 1);
};

const testDispatchSuppressesLowPrioritySameKindWithinWindow = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: [],
          staleNotes:
            currentTime.getTime() < new Date("2026-05-29T01:00:00.000Z").getTime()
              ? ["Policy card is stale: pc-1"]
              : ["Policy card is stale: pc-2"],
          conflicts: [],
          createdAtIso: currentTime.toISOString(),
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
      proactiveHelpLevel: "medium",
      askForFeedbackSparingly: false,
    },
    dispatchSuppressionWindowMs: 60 * 60 * 1000,
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T00:10:00.000Z");
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T02:10:00.000Z");
  const third = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(third.length, 1);
  assert.equal(enqueued.length, 2);
};

const testDispatchDoesNotSuppressHighPriorityDuplicates = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const insights: RelationshipMemoryInsights = {
    botId: "ao",
    threadId: "thread-1",
    report: {
      gaps: [],
      staleNotes: [],
      conflicts: ["Conflicting recommended behavior detected for implementation support."],
      createdAtIso: "2026-05-29T00:00:00.000Z",
    },
  };
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => insights,
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
      askForFeedbackSparingly: false,
      proactiveHelpLevel: "low",
    },
    dispatchSuppressionWindowMs: 60 * 60 * 1000,
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T00:00:05.000Z");
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]?.sourceTaskId, second[0]?.sourceTaskId);
  assert.equal(enqueued.length, 2);
};

const testDispatchSuppressesLowPriorityWhenRecentTurnIsTooFresh = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: currentTime.toISOString(),
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
      askForFeedbackSparingly: true,
      proactiveHelpLevel: "low",
    },
    minTurnAgeMsBeforeLowPriorityDispatch: 60 * 1000,
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T00:02:00.000Z");
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(enqueued.length, 1);
};

const testDispatchIncludesWorkUnitMetadata = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const result = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(result.length, 1);
  assert.equal(enqueued.length, 1);
  assert.ok(result[0]?.sourceUnitId);
  assert.equal(result[0]?.sourceUnitStep, "intervene");
};

const testDispatchDoesNotSuppressDifferentWorkUnitsWithinWindow = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  let stale = "Policy card is stale: pc-1";
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: [],
          staleNotes: [stale],
          conflicts: [],
          createdAtIso: currentTime.toISOString(),
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    policy: {
      maxBackgroundInputsPerRun: 1,
      askForFeedbackSparingly: false,
      proactiveHelpLevel: "medium",
    },
    dispatchSuppressionWindowMs: 60 * 60 * 1000,
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T00:10:00.000Z");
  stale = "Policy card is stale: pc-2";
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0]?.sourceUnitId, second[0]?.sourceUnitId);
};

const testIngestTurnRecordAppendsToStore = async (): Promise<void> => {
  const store = createInMemoryTurnRecordStore();
  const service = createRelationshipSystemService({
    turnRecordStore: store,
    policyStateStore: createInMemoryPolicyStateStore(),
  });

  await service.ingestTurnRecord({
    botId: "ao",
    threadId: "thread-1",
    createdAtIso: "2026-05-29T00:00:00.000Z",
    messages: [
      {
        role: "user",
        content: "こんにちは",
        timestampIso: "2026-05-29T00:00:00.000Z",
      },
    ],
  });

  const saved = await store.listRecentTurnRecords({
    botId: "ao",
    threadId: "thread-1",
    limit: 5,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.messages[0]?.content, "こんにちは");
};

const testPlanRelationshipTasksWithLlmUsesFeedbackAndMemoryImprovement = async (): Promise<void> => {
  const tasks = await planRelationshipTasksWithLlm(
    {
      botId: "ao",
      threadId: "thread-1",
      recentContextSummary:
        "Recent conversation history:\nRecent turn 1\n[user] You ask too many follow-up questions.",
      report: {
        gaps: ["The user's preferred proactive frequency is unknown."],
        staleNotes: [],
        conflicts: ["Conflicting recommended behavior detected for title: implementation support"],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
    },
    {
      proactiveHelpLevel: "medium",
      askForFeedbackSparingly: true,
      maxBackgroundInputsPerRun: 2,
    },
    new Date("2026-05-29T00:00:00.000Z"),
    {
      generateJson: async () => ({
        tasks: [
          {
            kind: "feedback_prepare",
            title: "Ask one preference question",
            purpose: "Clarify how often proactive follow-ups are welcome.",
            inputText: "Next time, ask one short question about preferred follow-up frequency.",
            priority: "medium",
            sourceSignals: ["The user's preferred proactive frequency is unknown."],
          },
          {
            kind: "memory_improvement",
            title: "Clarify conflict boundary",
            purpose: "Help memory-system separate conflicting response modes.",
            inputText: "When this topic returns, confirm whether the user wants concrete implementation guidance or research framing.",
            priority: "high",
            sourceSignals: ["Conflicting recommended behavior detected for title: implementation support"],
          },
        ],
      }),
    },
  );

  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["feedback_prepare", "memory_improvement"],
  );
  assert.match(tasks[1]?.purpose ?? "", /memory-system/i);
};

const testPlanTasksUsesRecentTurnFeedbackSummary = async (): Promise<void> => {
  let capturedPrompt = "";
  const store = createInMemoryTurnRecordStore([
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [
        {
          role: "assistant",
          content: "詳しく説明します。",
          timestampIso: "2026-05-29T00:00:00.000Z",
        },
        {
          role: "user",
          content: "もう少し短くお願いします。",
          timestampIso: "2026-05-29T00:00:10.000Z",
        },
      ],
    },
  ]);

  const service = createRelationshipSystemService({
    turnRecordStore: store,
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async () => {},
    },
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) => {
        capturedPrompt = userPrompt;
        return { tasks: [] };
      },
    },
  });

  await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.match(capturedPrompt, /Recent feedback-oriented conversation/);
  assert.match(capturedPrompt, /もう少し短くお願いします/);
};

const testPlanTasksUsesLlmFeedbackExtractionBeforePlanning = async (): Promise<void> => {
  const prompts: string[] = [];
  const store = createInMemoryTurnRecordStore([
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [
        {
          role: "assistant",
          content: "次からどれくらい詳しさが欲しいですか？",
          timestampIso: "2026-05-29T00:00:00.000Z",
        },
        {
          role: "user",
          content: "次からは短めで大丈夫です。",
          timestampIso: "2026-05-29T00:00:10.000Z",
        },
      ],
    },
  ]);

  const service = createRelationshipSystemService({
    turnRecordStore: store,
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
    backgroundInputSink: {
      enqueue: async () => {},
    },
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) => {
        prompts.push(userPrompt);
        if (prompts.length === 1) {
          return {
            summary:
              "The user prefers shorter follow-ups after being asked directly.",
            interventionFocus: "relationship",
            avoidFeedbackQuestions: false,
            preferConcisePrompts: true,
            proactiveInfoPreference: "unknown",
          };
        }
        if (prompts.length === 2) {
          return {
            preferredExecutionMode: "ask_user",
          };
        }
        if (prompts.length === 3) {
          return {
            summary:
              "The user prefers shorter follow-ups after being asked directly.",
            signals: ["prefers concise follow-ups"],
          };
        }
        return {
          tasks: [
            {
              kind: "feedback_prepare",
              title: "Keep follow-up concise",
              purpose: "Apply the newly clarified preference.",
              inputText: "When following up, keep the question short.",
              priority: "medium",
              sourceSignals: ["prefers concise follow-ups"],
            },
          ],
        };
      },
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(prompts.length, 4);
  assert.match(prompts[0] ?? "", /次からどれくらい詳しさが欲しいですか/);
  assert.match(
    prompts[1] ?? "",
    /次からどれくらい詳しさが欲しいですか/,
  );
  assert.match(
    prompts[2] ?? "",
    /次からどれくらい詳しさが欲しいですか/,
  );
  assert.match(
    prompts[3] ?? "",
    /The user prefers shorter follow-ups after being asked directly/,
  );
  assert.equal(tasks[0]?.kind, "feedback_prepare");
};

const testPolicyLearningSuppressesFeedbackQuestions = async (): Promise<void> => {
  const store = createInMemoryTurnRecordStore([
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [
        {
          role: "assistant",
          content: "次に確認してもよいですか？",
          timestampIso: "2026-05-29T00:00:00.000Z",
        },
        {
          role: "user",
          content: "質問は多すぎるので減らしてください。",
          timestampIso: "2026-05-29T00:00:10.000Z",
        },
      ],
    },
  ]);
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: store,
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });
  const saved = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(tasks.length, 0);
  assert.equal(saved?.avoidFeedbackQuestions, true);
};

const testPolicyLearningAddsConcisePromptHint = async (): Promise<void> => {
  const store = createInMemoryTurnRecordStore([
    {
      botId: "ao",
      threadId: "thread-1",
      createdAtIso: "2026-05-29T00:00:00.000Z",
      messages: [
        {
          role: "user",
          content: "短めにお願いします。",
          timestampIso: "2026-05-29T00:00:00.000Z",
        },
      ],
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: store,
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.match(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testHeuristicPlanningAddsMemoryImprovementTask = async (): Promise<void> => {
  const tasks = planRelationshipTasks(
    {
      botId: "ao",
      threadId: "thread-1",
      report: {
        gaps: ["Unknown preference."],
        staleNotes: [],
        conflicts: ["Conflicting recommended behavior detected for implementation support."],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
    },
    {
      proactiveHelpLevel: "medium",
      askForFeedbackSparingly: true,
      maxBackgroundInputsPerRun: 2,
    },
    new Date("2026-05-29T00:00:00.000Z"),
  );

  assert.equal(tasks.at(-1)?.kind, "memory_improvement");
  assert.match(tasks.at(-1)?.purpose ?? "", /memory system/i);
};

const testPolicyLearningPrefersMemoryInterventions = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "前回の区別を次回も維持します。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: ["Policy card is stale: pc-1"],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });
  const saved = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(saved?.interventionFocus, "memory");
  assert.equal(["info_gathering", "memory_improvement"].includes(tasks[0]?.kind ?? ""), true);
};

const testPolicyLearningSuppressesInfoGatheringWhenUserRejectsProactiveInfo = async (): Promise<void> => {
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "今は追加の情報は不要です。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: [],
          staleNotes: ["Policy card is stale: pc-1"],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(tasks.some((task) => task.kind === "info_gathering"), false);
};

const testQuestionAvoidanceDeprioritizesAskUserTasks = async (): Promise<void> => {
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "質問は多すぎるので減らしてください。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.equal(tasks[0]?.executionMode, "provide_info");
  assert.equal(tasks.at(-1)?.executionMode, "ask_user");
};

const testConcisePreferenceAlsoShortensProvideInfoTasks = async (): Promise<void> => {
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "短めにお願いします。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: [],
          staleNotes: [],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
  });

  const provideInfoTask = tasks.find((task) => task.executionMode === "provide_info");
  assert.match(provideInfoTask?.inputText ?? "", /Keep it brief/i);
};

const testDetailedPreferenceRelaxesConcisePromptPolicy = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "The user prefers concise prompts.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: true,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "user",
            content: "次はもう少し詳しく説明してください。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.preferConcisePrompts, false);
  assert.doesNotMatch(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testProactiveInfoWelcomeRelaxesAvoidPolicy = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "Avoid proactive information unless clearly useful.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "avoid",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "user",
            content: "追加情報もあると助かります。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: [],
          staleNotes: ["Policy card is stale: pc-1"],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.proactiveInfoPreference, "allow");
  assert.equal(tasks.some((task) => task.kind === "info_gathering"), true);
};

const testFocusRemainsStableWithoutStrongNewSignal = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "Prefer relationship-improvement interventions first.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.interventionFocus, "relationship");
};

const testPreferredExecutionModePersistsWithoutNewSignal = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "Brief proactive information currently appears effective.",
      interventionFocus: "balanced",
      preferredExecutionMode: "provide_info",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.preferredExecutionMode, "provide_info");
  assert.equal(tasks[0]?.executionMode, "ask_user");
};

const testPreferredExecutionModeCanShiftToProvideInfo = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "user",
            content: "追加情報もあると助かります。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.preferredExecutionMode, "provide_info");
  assert.equal(tasks.some((task) => task.executionMode === "provide_info"), true);
};

const testPolicyLearningUsesLongerWindowThanRecentSummary = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "追加情報もあると助かります。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:05:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:05:00.000Z",
          },
        ],
      },
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "では次に進めます。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
    recentTurnLimit: 1,
    policyLearningTurnLimit: 3,
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.preferredExecutionMode, "provide_info");
  assert.equal(tasks.some((task) => task.executionMode === "provide_info"), true);
};

const testExecutionModeLearningUsesItsOwnLongerWindow = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "追加情報もあると助かります。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:05:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:05:00.000Z",
          },
        ],
      },
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "では次に進めます。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
    recentTurnLimit: 1,
    policyLearningTurnLimit: 1,
    executionModeLearningTurnLimit: 3,
  });

  await service.planTasks({ botId: "ao", threadId: "thread-1" });
  const saved = await policyStore.getPolicyState({ botId: "ao", threadId: "thread-1" });

  assert.equal(saved?.preferredExecutionMode, "provide_info");
};

const testFocusTakesPriorityOverPreferredExecutionMode = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "Prefer memory-improvement interventions first.",
      interventionFocus: "memory",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: ["Policy card is stale: pc-1"],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks[0]?.executionMode, "collect_info");
};

const testAskUserSuppressionOverridesPreferredExecutionMode = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "The user prefers fewer feedback questions.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: true,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "thread-1",
        createdAtIso: "2026-05-29T00:10:00.000Z",
        messages: [
          {
            role: "assistant",
            content: "了解しました。",
            timestampIso: "2026-05-29T00:10:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: ["Policy card is stale: pc-1"],
          conflicts: ["Conflicting recommended behavior detected for implementation support."],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks[tasks.length - 1]?.executionMode, "ask_user");
};

const testUserScopeSharesPolicyAcrossThreads = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "channel-a:user-1",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "短めにお願いします。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    policyScopeMode: "user",
    memoryProvider: {
      getInsights: async ({ threadId }) => ({
        botId: "ao",
        threadId,
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  await service.planTasks({ botId: "ao", threadId: "channel-a:user-1" });
  const tasks = await service.planTasks({ botId: "ao", threadId: "channel-b:user-1" });
  const userScoped = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "user:user-1",
  });

  assert.equal(userScoped?.preferConcisePrompts, true);
  assert.match(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testHybridScopePrefersThreadOverride = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "user:user-1",
      summary: "The user prefers concise prompts.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: true,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
    {
      botId: "ao",
      threadId: "channel-a:user-1",
      summary: "Detailed prompts are acceptable when useful.",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:05:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: policyStore,
    policyScopeMode: "hybrid",
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "channel-a:user-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "channel-a:user-1",
  });

  assert.doesNotMatch(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testUserScopeUsesExplicitUserIdResolver = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "opaque-thread-a",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "短めにお願いします。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    policyScopeMode: "user",
    userScopeKeyResolver: ({ userId }) =>
      userId ? `user:${userId}` : null,
    memoryProvider: {
      getInsights: async ({ threadId }) => ({
        botId: "ao",
        threadId,
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  await service.planTasks({
    botId: "ao",
    threadId: "opaque-thread-a",
    userId: "user-1",
  });
  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "opaque-thread-b",
    userId: "user-1",
  });
  const userScoped = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "user:user-1",
  });

  assert.equal(userScoped?.preferConcisePrompts, true);
  assert.match(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testUserScopeFallsBackToThreadWhenUserKeyMissing = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "opaque-thread-a",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "短めにお願いします。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    policyScopeMode: "user",
    userScopeMissingUserIdMode: "fallback_thread",
    userScopeKeyResolver: () => null,
    memoryProvider: {
      getInsights: async ({ threadId }) => ({
        botId: "ao",
        threadId,
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  await service.planTasks({
    botId: "ao",
    threadId: "opaque-thread-a",
  });
  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "opaque-thread-b",
  });
  const scopedA = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "opaque-thread-a",
  });
  const scopedB = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "opaque-thread-b",
  });

  assert.equal(scopedA?.preferConcisePrompts, true);
  assert.equal(scopedB?.preferConcisePrompts, undefined);
  assert.doesNotMatch(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const testUserScopeSkipsWhenUserKeyMissingAndSkipModeEnabled = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore();
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore([
      {
        botId: "ao",
        threadId: "opaque-thread-a",
        createdAtIso: "2026-05-29T00:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "短めにお願いします。",
            timestampIso: "2026-05-29T00:00:00.000Z",
          },
        ],
      },
    ]),
    policyStateStore: policyStore,
    policyScopeMode: "user",
    userScopeMissingUserIdMode: "skip_user_scope",
    userScopeKeyResolver: () => null,
    memoryProvider: {
      getInsights: async ({ threadId }) => ({
        botId: "ao",
        threadId,
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        },
      }),
    },
  });

  await service.planTasks({
    botId: "ao",
    threadId: "opaque-thread-a",
  });

  const scopedA = await policyStore.getPolicyState({
    botId: "ao",
    threadId: "opaque-thread-a",
  });
  assert.equal(scopedA, null);
};

const testHybridScopeMergesWithThreadFieldPriority = async (): Promise<void> => {
  const policyStore = createInMemoryPolicyStateStore([
    {
      botId: "ao",
      threadId: "user:user-1",
      summary: "User baseline summary",
      interventionFocus: "memory",
      preferredExecutionMode: "collect_info",
      avoidFeedbackQuestions: true,
      preferConcisePrompts: true,
      proactiveInfoPreference: "allow",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
    {
      botId: "ao",
      threadId: "thread-1",
      summary: "Thread override summary",
      interventionFocus: "relationship",
      preferredExecutionMode: "ask_user",
      avoidFeedbackQuestions: false,
      preferConcisePrompts: false,
      proactiveInfoPreference: "unknown",
      updatedAtIso: "2026-05-29T00:05:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: policyStore,
    policyScopeMode: "hybrid",
    userScopeKeyResolver: ({ userId }) =>
      userId ? `user:${userId}` : null,
    memoryProvider: {
      getInsights: async () => ({
        botId: "ao",
        threadId: "thread-1",
        report: {
          gaps: ["Unknown preference."],
          staleNotes: [],
          conflicts: [],
          createdAtIso: "2026-05-29T00:10:00.000Z",
        },
      }),
    },
  });

  const tasks = await service.planTasks({
    botId: "ao",
    threadId: "thread-1",
    userId: "user-1",
  });

  assert.doesNotMatch(tasks[0]?.inputText ?? "", /one short sentence/i);
};

const createInMemoryTurnRecordStore = (
  initial: TurnRecord[] = [],
): RelationshipTurnRecordStore => {
  const items = [...initial];
  return {
    appendTurnRecord: async (turn) => {
      items.push(turn);
    },
    listRecentTurnRecords: async ({ botId, threadId, limit }) =>
      items
        .filter((turn) => turn.botId === botId && turn.threadId === threadId)
        .slice(-limit),
  };
};

const createInMemoryPolicyStateStore = (
  initial: RelationshipInterventionPolicyState[] = [],
): RelationshipPolicyStateStore => {
  const map = new Map(
    initial.map((state) => [`${state.botId}:${state.threadId}`, state] as const),
  );
  return {
    getPolicyState: async ({ botId, threadId }) =>
      map.get(`${botId}:${threadId}`) ?? null,
    savePolicyState: async (state) => {
      map.set(`${state.botId}:${state.threadId}`, state);
    },
  };
};

void run();
