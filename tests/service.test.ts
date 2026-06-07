import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildRecentFeedbackSummaryWithLlm,
  createRelationshipSystemService,
  planRelationshipTasks,
  planRelationshipTasksWithLlm,
  summarizeOrganizeTaskWithLlm,
} from "../src/relationship_system/api/service";
import {
  BackgroundInput,
  RelationshipInterventionPolicyState,
  RelationshipMemoryInsights,
  RelationshipPlanningModel,
  RelationshipPolicyStateStore,
  RelationshipTurnRecordStore,
  RelationshipWorkUnitKind,
  RelationshipWorkUnitState,
  RelationshipWorkUnitStateStore,
  TurnRecord,
} from "../src/relationship_system/domain/types";

const testPlanRelationshipTasksCreatesOrganizeSteps = async (): Promise<void> => {
  const tasks = planRelationshipTasks(
    createInsights({
      clarificationCandidates: [
        "The user's preferred proactive frequency is unknown.",
      ],
      proactiveContextCandidates: ["Share the latest implementation constraint."],
      repairCandidates: [
        "The assistant recently mismatched implementation framing.",
      ],
      boundaryCandidates: ["Clarify implementation support vs research framing."],
    }),
    defaultPolicy(),
    new Date("2026-05-29T00:00:00.000Z"),
  );

  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["preference_gap", "stale_context", "conflict_resolution", "memory_boundary"],
  );
  assert.deepEqual(tasks.map((task) => task.unitStep), ["organize", "organize", "organize", "organize"]);
  assert.deepEqual(tasks.map((task) => task.executionMode), ["collect_info", "collect_info", "collect_info", "collect_info"]);
};

const testPlanRelationshipTasksWithLlmFallsBackToHeuristic = async (): Promise<void> => {
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => ({ tasks: [] }),
  };
  const tasks = await planRelationshipTasksWithLlm(
    createInsights({
      clarificationCandidates: ["Unknown preference."],
      repairCandidates: ["Mismatch"],
    }),
    defaultPolicy(),
    new Date("2026-05-29T00:00:00.000Z"),
    plannerModel,
  );

  assert.equal(tasks[0]?.unitStep, "organize");
  assert.equal(tasks[0]?.kind, "preference_gap");
};

const testPlanRelationshipTasksWithLlmExplainsInputAndOutputSchema = async (): Promise<void> => {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async (systemPrompt, userPrompt) => {
      calls.push({ systemPrompt, userPrompt });
      return { tasks: [] };
    },
  };

  await planRelationshipTasksWithLlm(
    createInsights({
      clarificationCandidates: ["Unknown preference."],
      repairCandidates: ["Mismatch"],
    }),
    defaultPolicy(),
    new Date("2026-05-29T00:00:00.000Z"),
    plannerModel,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.systemPrompt, /relationshipInsightReport の意味:/);
  assert.match(calls[0]!.systemPrompt, /kind に使える値は厳密に次の 4 つだけです/);
  assert.match(calls[0]!.systemPrompt, /unitStep に使える値は厳密に次の 3 つだけです/);
  assert.match(calls[0]!.systemPrompt, /executionMode に使える値は厳密に次の 3 つだけです/);
  assert.match(calls[0]!.userPrompt, /"relationshipInsightReport":/);
  assert.match(calls[0]!.userPrompt, /"existingWorkUnits":/);
  assert.match(calls[0]!.userPrompt, /"heuristicPlan":/);
  assert.match(calls[0]!.userPrompt, /kind: one of preference_gap/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"botId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"threadId":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"createdAtIso":/);
  assert.doesNotMatch(calls[0]!.userPrompt, /"id":/);
};

const testPlanRelationshipTasksWithLlmSkipsLlmWhenBaseTasksAreEmpty = async (): Promise<void> => {
  let called = false;
  const plannerModel: RelationshipPlanningModel = {
    generateJson: async () => {
      called = true;
      return { tasks: [] };
    },
  };

  const tasks = await planRelationshipTasksWithLlm(
    createInsights({}),
    defaultPolicy(),
    new Date("2026-05-29T00:00:00.000Z"),
    plannerModel,
  );

  assert.deepEqual(tasks, []);
  assert.equal(called, false);
};

const testBuildRecentFeedbackSummaryWithLlmExplainsSchemaAndPassesMinimalFields =
  async (): Promise<void> => {
    const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const plannerModel: RelationshipPlanningModel = {
      generateJson: async (systemPrompt, userPrompt) => {
        calls.push({ systemPrompt, userPrompt });
        return { summary: "The user wants fewer confirmation prompts.", signals: ["too many confirmations"] };
      },
    };

    const summary = await buildRecentFeedbackSummaryWithLlm(
      [
        assistantTurn("ao", "thread-1", "2026-05-29T00:00:00.000Z", "最近の確認頻度はどうですか。"),
        userTurn("ao", "thread-1", "2026-05-29T00:01:00.000Z", "少し多いです"),
      ],
      plannerModel,
    );

    assert.match(summary, /The user wants fewer confirmation prompts/);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.systemPrompt, /recentTurns には assistant と user の message だけが時系列順で入っています/);
    assert.match(calls[0]!.userPrompt, /"recentTurns":/);
    assert.match(calls[0]!.userPrompt, /signals/);
    assert.doesNotMatch(calls[0]!.userPrompt, /fallbackHeuristicSummary/);
  };

const testBuildRecentFeedbackSummaryWithLlmSkipsLlmWithoutFeedbackProbe =
  async (): Promise<void> => {
    let called = false;
    const plannerModel: RelationshipPlanningModel = {
      generateJson: async () => {
        called = true;
        return { summary: "unused" };
      },
    };

    const summary = await buildRecentFeedbackSummaryWithLlm(
      [
        assistantTurn("ao", "thread-1", "2026-05-29T00:00:00.000Z", "実装を進めます。"),
        userTurn("ao", "thread-1", "2026-05-29T00:01:00.000Z", "お願いします"),
      ],
      plannerModel,
    );

    assert.match(summary, /Recent feedback-oriented conversation:/);
    assert.equal(called, false);
  };

const testSummarizeOrganizeTaskWithLlmExplainsSchemaAndPassesMinimalFields =
  async (): Promise<void> => {
    const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const plannerModel: RelationshipPlanningModel = {
      generateJson: async (systemPrompt, userPrompt) => {
        calls.push({ systemPrompt, userPrompt });
        return { summary: "次回は好みを一つだけ確認する。" };
      },
    };

    const summary = await summarizeOrganizeTaskWithLlm(
      {
        id: "task-1",
        unitId: "unit-1",
        unitStep: "organize",
        botId: "ao",
        threadId: "thread-1",
        kind: "preference_gap",
        executionMode: "collect_info",
        title: "Clarify one user preference",
        purpose: "Prepare one concrete preference clarification.",
        inputText: "Organize the context for Clarify one user preference: Unknown preference.",
        priority: "medium",
        sourceSignals: ["Unknown preference.", "The user's proactive frequency is unknown."],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
      plannerModel,
    );

    assert.equal(summary, "次回は好みを一つだけ確認する。");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.systemPrompt, /organizeStep には、完了した内部 organize step についての最小情報だけが入っています/);
    assert.match(calls[0]!.userPrompt, /"organizeStep":/);
    assert.doesNotMatch(calls[0]!.userPrompt, /"id":/);
    assert.doesNotMatch(calls[0]!.userPrompt, /"botId":/);
    assert.doesNotMatch(calls[0]!.userPrompt, /"threadId":/);
    assert.doesNotMatch(calls[0]!.userPrompt, /"createdAtIso":/);
  };

const testSummarizeOrganizeTaskWithLlmSkipsLlmForSimpleSingleSignalTask =
  async (): Promise<void> => {
    let called = false;
    const plannerModel: RelationshipPlanningModel = {
      generateJson: async () => {
        called = true;
        return { summary: "unused" };
      },
    };

    const summary = await summarizeOrganizeTaskWithLlm(
      {
        id: "task-1",
        unitId: "unit-1",
        unitStep: "organize",
        botId: "ao",
        threadId: "thread-1",
        kind: "preference_gap",
        executionMode: "collect_info",
        title: "Clarify one user preference",
        purpose: "Prepare one concrete preference clarification.",
        inputText: "Organize the context for Clarify one user preference: Unknown preference.",
        priority: "medium",
        sourceSignals: ["Unknown preference."],
        createdAtIso: "2026-05-29T00:00:00.000Z",
      },
      plannerModel,
    );

    assert.match(summary, /次回はユーザーに一つだけ具体的な好みを確認する/);
    assert.equal(called, false);
  };

const testDispatchExecutesOrganizeThenIntervenes = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () =>
        createInsights({ clarificationCandidates: ["Unknown preference."] }),
    },
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const dispatched = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(dispatched.length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(dispatched[0]?.sourceUnitStep, "intervene");
  assert.match(dispatched[0]?.text ?? "", /確認です。/);
};

const testDispatchSuppressesDuplicateIntervention = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () =>
        createInsights({ clarificationCandidates: ["Unknown preference."] }),
    },
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(enqueued.length, 1);
};

const testHighPriorityConflictCanRepeat = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  let currentTime = new Date("2026-05-29T00:00:00.000Z");
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () =>
        createInsights({
          repairCandidates: [
            "Conflicting recommended behavior detected for implementation support.",
          ],
        }),
    },
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    dispatchSuppressionWindowMs: 60 * 60 * 1000,
    now: () => currentTime,
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  currentTime = new Date("2026-05-29T00:00:05.000Z");
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(enqueued.length, 2);
};

const testQueueBacklogSuppressesDispatch = async (): Promise<void> => {
  const enqueued: BackgroundInput[] = [];
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    memoryProvider: {
      getInsights: async () =>
        createInsights({ clarificationCandidates: ["Unknown preference."] }),
    },
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    queueStatusProvider: async () => ({ locked: 0, readyUser: 1, readyScheduled: 0 }),
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const dispatched = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(dispatched.length, 0);
  assert.equal(enqueued.length, 0);
};

const testSecondDispatchCreatesObserveStep = async (): Promise<void> => {
  const workUnitStore = createInMemoryWorkUnitStateStore();
  const enqueued: BackgroundInput[] = [];
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () =>
        createInsights({
          proactiveContextCandidates: ["Policy card is stale: pc-1"],
        }),
    },
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-05-29T00:00:00.000Z"),
  });

  const first = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  const second = await service.dispatchTasks({ botId: "ao", threadId: "thread-1" });
  const units = await workUnitStore.listWorkUnits({ botId: "ao", threadId: "thread-1" });

  assert.equal(first[0]?.sourceUnitStep, "intervene");
  assert.equal(second[0]?.sourceUnitStep, "observe");
  assert.equal(units[0]?.currentStep, "observe");
  assert.equal(units[0]?.status, "waiting_for_response");
  assert.match(units[0]?.lastObservationPrompt ?? "", /頻度/);
};

const testUnrelatedUserReplyDoesNotCountAsObservationResponse = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const unitId = buildUnitIdLike("ao", "thread-1", "stale_context", source);
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId,
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "observe",
      status: "waiting_for_response",
      sourceSignals: [source],
      lastInterventionAtIso: "2026-05-29T00:00:00.000Z",
      lastObservationPrompt: "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。",
      responseWindowTurns: 2,
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const turnStore = createInMemoryTurnRecordStore([
    assistantTurn("ao", "thread-1", "2026-05-29T00:00:00.000Z", "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。"),
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: turnStore,
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
  });

  await service.ingestTurnRecord(userTurn("ao", "thread-1", "2026-05-29T00:01:00.000Z", "ところで次の実装ですが"));
  await service.ingestTurnRecord(assistantTurn("ao", "thread-1", "2026-05-29T00:02:00.000Z", "了解です"));
  const units = await workUnitStore.listWorkUnits({ botId: "ao", threadId: "thread-1" });

  assert.equal(units[0]?.status, "no_signal");
};

const testFeedbackLikeReplyUpdatesObservation = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const unitId = buildUnitIdLike("ao", "thread-1", "stale_context", source);
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId,
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "observe",
      status: "waiting_for_response",
      sourceSignals: [source],
      lastInterventionAtIso: "2026-05-29T00:00:00.000Z",
      lastObservationPrompt: "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。",
      responseWindowTurns: 2,
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const turnStore = createInMemoryTurnRecordStore([
    assistantTurn("ao", "thread-1", "2026-05-29T00:00:00.000Z", "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。"),
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: turnStore,
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
  });

  await service.ingestTurnRecord(userTurn("ao", "thread-1", "2026-05-29T00:01:00.000Z", "少し多いです。"));
  const units = await workUnitStore.listWorkUnits({ botId: "ao", threadId: "thread-1" });

  assert.equal(units[0]?.status, "response_received");
  assert.equal(units[0]?.observedResponseText, "少し多いです。");
};

const testPlanTasksSkipsWaitingObserveUnit = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: buildUnitIdLike("ao", "thread-1", "stale_context", source),
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "observe",
      status: "waiting_for_response",
      sourceSignals: [source],
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () =>
        createInsights({ proactiveContextCandidates: [source] }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks.length, 0);
};

const testPlanTasksBuildsInterveneFromCompletedOrganizeUnit = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: buildUnitIdLike("ao", "thread-1", "stale_context", source),
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "organize",
      status: "internal_completed",
      sourceSignals: [source],
      organizeSummary: "最新の前提として短く共有できる。",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: createInMemoryPolicyStateStore(),
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () =>
        createInsights({ proactiveContextCandidates: [source] }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks[0]?.unitStep, "intervene");
  assert.equal(tasks[0]?.executionMode, "provide_info");
  assert.match(tasks[0]?.inputText ?? "", /^補足です。/);
};

const testObservationIsSuppressedWhenPolicyAvoidsFeedbackQuestions = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: buildUnitIdLike("ao", "thread-1", "stale_context", source),
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "intervene",
      status: "intervened",
      sourceSignals: [source],
      lastInterventionText: "補足です。最新情報です。",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const policyStateStore = createInMemoryPolicyStateStore({
    botId: "ao",
    threadId: "thread-1",
    summary: "Avoid feedback questions.",
    interventionFocus: "relationship",
    preferredExecutionMode: "balanced",
    avoidFeedbackQuestions: true,
    preferConcisePrompts: false,
    proactiveInfoPreference: "unknown",
    updatedAtIso: "2026-05-29T00:00:00.000Z",
  });
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore,
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () =>
        createInsights({ proactiveContextCandidates: [source] }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.equal(tasks.length, 0);
};

const testConcisePolicyAppliesToUserFacingIntervention = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: buildUnitIdLike("ao", "thread-1", "stale_context", source),
      botId: "ao",
      threadId: "thread-1",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "organize",
      status: "internal_completed",
      sourceSignals: [source],
      organizeSummary: "最新の前提を一文で共有できる。",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const policyStateStore = createInMemoryPolicyStateStore({
    botId: "ao",
    threadId: "thread-1",
    summary: "Prefer concise prompts.",
    interventionFocus: "memory",
    preferredExecutionMode: "provide_info",
    avoidFeedbackQuestions: false,
    preferConcisePrompts: true,
    proactiveInfoPreference: "allow",
    updatedAtIso: "2026-05-29T00:00:00.000Z",
  });
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore,
    workUnitStateStore: workUnitStore,
    memoryProvider: {
      getInsights: async () =>
        createInsights({ proactiveContextCandidates: [source] }),
    },
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-1" });
  assert.match(tasks[0]?.inputText ?? "", /Keep it brief/i);
};

const testUserScopeSharesPolicyAcrossThreads = async (): Promise<void> => {
  const source = "Policy card is stale: pc-1";
  const policyStore = createInMemoryPolicyStateStore({
    botId: "ao",
    threadId: "user:u-1",
    summary: "Prefer concise prompts.",
    interventionFocus: "memory",
    preferredExecutionMode: "provide_info",
    avoidFeedbackQuestions: false,
    preferConcisePrompts: true,
    proactiveInfoPreference: "allow",
    updatedAtIso: "2026-05-29T00:00:00.000Z",
  });
  const workUnitStore = createInMemoryWorkUnitStateStore([
    {
      unitId: buildUnitIdLike("ao", "thread-a", "stale_context", source),
      botId: "ao",
      threadId: "thread-a",
      kind: "stale_context",
      title: "Refresh stale context",
      currentStep: "organize",
      status: "internal_completed",
      sourceSignals: [source],
      organizeSummary: "最新の前提を一文で共有できる。",
      updatedAtIso: "2026-05-29T00:00:00.000Z",
    },
  ]);
  const service = createRelationshipSystemService({
    turnRecordStore: createInMemoryTurnRecordStore(),
    policyStateStore: policyStore,
    workUnitStateStore: workUnitStore,
    policyScopeMode: "user",
    memoryProvider: {
      getInsights: async () =>
        createInsights({
          threadId: "thread-a",
          proactiveContextCandidates: [source],
        }),
    },
    userScopeKeyResolver: () => "user:u-1",
  });

  const tasks = await service.planTasks({ botId: "ao", threadId: "thread-a", userId: "u-1" });
  assert.match(tasks[0]?.inputText ?? "", /Keep it brief/i);
};

test("planRelationshipTasks creates organize steps", testPlanRelationshipTasksCreatesOrganizeSteps);
test("planRelationshipTasksWithLlm falls back to heuristic", testPlanRelationshipTasksWithLlmFallsBackToHeuristic);
test("planRelationshipTasksWithLlm explains input and output schema", testPlanRelationshipTasksWithLlmExplainsInputAndOutputSchema);
test("planRelationshipTasksWithLlm skips llm when base tasks are empty", testPlanRelationshipTasksWithLlmSkipsLlmWhenBaseTasksAreEmpty);
test("buildRecentFeedbackSummaryWithLlm explains schema and passes minimal fields", testBuildRecentFeedbackSummaryWithLlmExplainsSchemaAndPassesMinimalFields);
test("buildRecentFeedbackSummaryWithLlm skips llm without feedback probe", testBuildRecentFeedbackSummaryWithLlmSkipsLlmWithoutFeedbackProbe);
test("summarizeOrganizeTaskWithLlm explains schema and passes minimal fields", testSummarizeOrganizeTaskWithLlmExplainsSchemaAndPassesMinimalFields);
test("summarizeOrganizeTaskWithLlm skips llm for simple single-signal task", testSummarizeOrganizeTaskWithLlmSkipsLlmForSimpleSingleSignalTask);
test("dispatch executes organize then intervenes", testDispatchExecutesOrganizeThenIntervenes);
test("dispatch suppresses duplicate intervention", testDispatchSuppressesDuplicateIntervention);
test("high priority conflict can repeat", testHighPriorityConflictCanRepeat);
test("queue backlog suppresses dispatch", testQueueBacklogSuppressesDispatch);
test("second dispatch creates observe step", testSecondDispatchCreatesObserveStep);
test("unrelated user reply does not count as observation response", testUnrelatedUserReplyDoesNotCountAsObservationResponse);
test("feedback-like reply updates observation", testFeedbackLikeReplyUpdatesObservation);
test("planTasks skips waiting observe unit", testPlanTasksSkipsWaitingObserveUnit);
test("planTasks builds intervene from completed organize unit", testPlanTasksBuildsInterveneFromCompletedOrganizeUnit);
test("observation is suppressed when policy avoids feedback questions", testObservationIsSuppressedWhenPolicyAvoidsFeedbackQuestions);
test("concise policy applies to user-facing intervention", testConcisePolicyAppliesToUserFacingIntervention);
test("user scope shares policy across threads", testUserScopeSharesPolicyAcrossThreads);

function createInsights(input: {
  botId?: string;
  threadId?: string;
  clarificationCandidates?: string[];
  proactiveContextCandidates?: string[];
  repairCandidates?: string[];
  boundaryCandidates?: string[];
}): RelationshipMemoryInsights {
  return {
    botId: input.botId ?? "ao",
    threadId: input.threadId ?? "thread-1",
    report: {
      clarificationCandidates: input.clarificationCandidates ?? [],
      proactiveContextCandidates: input.proactiveContextCandidates ?? [],
      repairCandidates: input.repairCandidates ?? [],
      boundaryCandidates: input.boundaryCandidates ?? [],
      createdAtIso: "2026-05-29T00:00:00.000Z",
    },
  };
}

function defaultPolicy() {
  return {
    proactiveHelpLevel: "medium" as const,
    askForFeedbackSparingly: true,
    maxBackgroundInputsPerRun: 1,
  };
}

function assistantTurn(botId: string, threadId: string, createdAtIso: string, content: string): TurnRecord {
  return {
    botId,
    threadId,
    createdAtIso,
    messages: [{ role: "assistant", content, timestampIso: createdAtIso }],
  };
}

function userTurn(botId: string, threadId: string, createdAtIso: string, content: string): TurnRecord {
  return {
    botId,
    threadId,
    createdAtIso,
    messages: [{ role: "user", content, timestampIso: createdAtIso }],
  };
}

function buildUnitIdLike(
  botId: string,
  threadId: string,
  kind: RelationshipWorkUnitKind,
  source: string,
): string {
  return `unit_${sanitize(botId)}_${sanitize(threadId)}_${kind}_${sanitize(source).slice(0, 64)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function createInMemoryTurnRecordStore(initial: TurnRecord[] = []): RelationshipTurnRecordStore {
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

function createInMemoryWorkUnitStateStore(
  initial: RelationshipWorkUnitState[] = [],
): RelationshipWorkUnitStateStore {
  const items = new Map<string, RelationshipWorkUnitState[]>();
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
