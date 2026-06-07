import {
  BackgroundInput,
  BackgroundInputSink,
  RelationshipExecutionModePreference,
  RelationshipInterventionFocus,
  ProactiveInfoPreference,
  RelationshipExecutionMode,
  RelationshipInterventionPolicyState,
  RelationshipMemoryInsights,
  RelationshipMemoryProvider,
  RelationshipPlanningModel,
  RelationshipPolicy,
  RelationshipPolicyStateStore,
  RelationshipTask,
  RelationshipTurnRecordStore,
  TurnRecord,
  RelationshipWorkUnitState,
  RelationshipWorkUnitStateStore,
} from "../domain/types";
import {
  buildMemoryReportSignature,
  buildTaskFingerprint,
  buildThreadKey,
  isUserFacingTask,
  normalizeUserFacingTaskText,
  planRelationshipTasks,
  planRelationshipTasksWithLlm,
  toBackgroundInput,
} from "./taskPlanning";
import { observeFeedbackResponse } from "./observeAdjust";
import {
  applyInterventionPolicyState,
  learnInterventionPolicyState,
} from "./policyLearning";
export {
  planRelationshipTasks,
  planRelationshipTasksWithLlm,
} from "./taskPlanning";

export interface RelationshipSystemService {
  ingestTurnRecord(input: TurnRecord): Promise<void>;
  planTasks(input: {
    botId: string;
    threadId: string;
    userId?: string;
    channelId?: string;
  }): Promise<RelationshipTask[]>;
  dispatchTasks(input: {
    botId: string;
    threadId: string;
    userId?: string;
    channelId?: string;
  }): Promise<BackgroundInput[]>;
}

interface RelationshipScopeContext {
  botId: string;
  threadId: string;
  userId?: string;
  channelId?: string;
}

export interface RelationshipSystemOptions {
  turnRecordStore: RelationshipTurnRecordStore;
  policyStateStore?: RelationshipPolicyStateStore;
  memoryProvider?: RelationshipMemoryProvider;
  backgroundInputSink?: BackgroundInputSink;
  workUnitStateStore?: RelationshipWorkUnitStateStore;
  plannerModel?: RelationshipPlanningModel;
  policy?: Partial<RelationshipPolicy>;
  policyScopeMode?: "thread" | "user" | "hybrid";
  userScopeMissingUserIdMode?: "fallback_thread" | "skip_user_scope";
  userScopeKeyResolver?: (input: RelationshipScopeContext) => string | null;
  recentTurnLimit?: number;
  policyLearningTurnLimit?: number;
  executionModeLearningTurnLimit?: number;
  dispatchSuppressionWindowMs?: number;
  minTurnAgeMsBeforeLowPriorityDispatch?: number;
  minPolicyFlipIntervalMs?: number;
  queueStatusProvider?: () => Promise<{
    locked: number;
    readyUser: number;
    readyScheduled: number;
  }>;
  maxReadyQueueTasksBeforeSuppression?: number;
  now?: () => Date;
}

const DEFAULT_POLICY: RelationshipPolicy = {
  proactiveHelpLevel: "medium",
  askForFeedbackSparingly: true,
  maxBackgroundInputsPerRun: 1,
};

class DefaultRelationshipSystemService implements RelationshipSystemService {
  private readonly policy: RelationshipPolicy;
  private readonly workUnitStateStore: RelationshipWorkUnitStateStore;
  private readonly now: () => Date;
  private readonly recentTurnLimit: number;
  private readonly policyLearningTurnLimit: number;
  private readonly executionModeLearningTurnLimit: number;
  private readonly policyScopeMode: "thread" | "user" | "hybrid";
  private readonly userScopeKeyResolver: (
    input: RelationshipScopeContext,
  ) => string | null;
  private readonly userScopeMissingUserIdMode:
    | "fallback_thread"
    | "skip_user_scope";
  private readonly dispatchSuppressionWindowMs: number;
  private readonly minTurnAgeMsBeforeLowPriorityDispatch: number;
  private readonly minPolicyFlipIntervalMs: number;
  private readonly maxReadyQueueTasksBeforeSuppression: number;
  private readonly lastReportSignatureByThread = new Map<string, string>();
  private readonly lastDispatchedReportSignatureByThread = new Map<
    string,
    string
  >();
  private readonly lastDispatchedTaskFingerprintByThread = new Map<
    string,
    string
  >();
  private readonly lastDispatchedAtByThread = new Map<string, number>();
  private readonly latestTurnAtByThread = new Map<string, number>();

  constructor(private readonly options: RelationshipSystemOptions) {
    this.policy = {
      ...DEFAULT_POLICY,
      ...options.policy,
    };
    this.workUnitStateStore =
      options.workUnitStateStore ?? createInMemoryWorkUnitStateStore();
    this.now = options.now ?? (() => new Date());
    this.recentTurnLimit = Math.max(1, options.recentTurnLimit ?? 4);
    this.policyLearningTurnLimit = Math.max(
      this.recentTurnLimit,
      options.policyLearningTurnLimit ?? Math.max(8, this.recentTurnLimit),
    );
    this.executionModeLearningTurnLimit = Math.max(
      this.policyLearningTurnLimit,
      options.executionModeLearningTurnLimit ??
        Math.max(16, this.policyLearningTurnLimit),
    );
    this.policyScopeMode = options.policyScopeMode ?? "thread";
    this.userScopeMissingUserIdMode =
      options.userScopeMissingUserIdMode ?? "fallback_thread";
    this.userScopeKeyResolver =
      options.userScopeKeyResolver ?? defaultUserScopeKeyResolver;
    this.dispatchSuppressionWindowMs = Math.max(
      0,
      options.dispatchSuppressionWindowMs ?? 2 * 60 * 60 * 1000,
    );
    this.minTurnAgeMsBeforeLowPriorityDispatch = Math.max(
      0,
      options.minTurnAgeMsBeforeLowPriorityDispatch ?? 10 * 60 * 1000,
    );
    this.minPolicyFlipIntervalMs = Math.max(
      0,
      options.minPolicyFlipIntervalMs ?? 30 * 60 * 1000,
    );
    this.maxReadyQueueTasksBeforeSuppression = Math.max(
      0,
      options.maxReadyQueueTasksBeforeSuppression ?? 1,
    );
  }

  async ingestTurnRecord(input: TurnRecord): Promise<void> {
    await this.options.turnRecordStore.appendTurnRecord(input);
    await this.updateObservedWorkUnits(input);
  }

  async planTasks(input: {
    botId: string;
    threadId: string;
    userId?: string;
    channelId?: string;
  }): Promise<RelationshipTask[]> {
    if (!this.options.memoryProvider) {
      throw new Error("memoryProvider is required to plan relationship tasks");
    }

    const fetchTurnLimit = Math.max(
      this.policyLearningTurnLimit,
      this.executionModeLearningTurnLimit,
    );
    const [insights, recentTurns, currentPolicyState, workUnitStates] =
      await Promise.all([
        this.options.memoryProvider.getInsights(input),
        this.options.turnRecordStore.listRecentTurnRecords({
          botId: input.botId,
          threadId: input.threadId,
          limit: fetchTurnLimit,
        }),
        loadScopedPolicyState(
          this.options.policyStateStore,
          input,
          this.policyScopeMode,
          this.userScopeKeyResolver,
          this.userScopeMissingUserIdMode,
        ),
        this.workUnitStateStore.listWorkUnits({
          botId: input.botId,
          threadId: input.threadId,
        }),
      ]);
    console.log("insights", insights);
    const learningTurns = recentTurns.slice(-this.policyLearningTurnLimit);
    const executionModeLearningTurns = recentTurns.slice(
      -this.executionModeLearningTurnLimit,
    );
    const summaryTurns = recentTurns.slice(-this.recentTurnLimit);
    const threadKey = buildThreadKey(input.botId, input.threadId);
    this.lastReportSignatureByThread.set(
      threadKey,
      buildMemoryReportSignature(insights),
    );
    const latestTurn = recentTurns[recentTurns.length - 1];
    if (latestTurn) {
      const turnTs = Date.parse(latestTurn.createdAtIso);
      if (Number.isFinite(turnTs)) {
        this.latestTurnAtByThread.set(threadKey, turnTs);
      }
    }

    const nextPolicyState = await learnInterventionPolicyState({
      botId: input.botId,
      threadId: input.threadId,
      now: this.now(),
      minPolicyFlipIntervalMs: this.minPolicyFlipIntervalMs,
      insights,
      recentTurns: learningTurns,
      executionModeLearningTurns,
      workUnitStates,
      currentPolicyState,
      plannerModel: this.options.plannerModel,
    });
    if (nextPolicyState && this.options.policyStateStore) {
      await saveScopedPolicyState(
        this.options.policyStateStore,
        nextPolicyState,
        this.policyScopeMode,
        this.userScopeKeyResolver,
        this.userScopeMissingUserIdMode,
        input,
      );
    }

    const recentSummary = this.options.plannerModel
      ? await buildRecentFeedbackSummaryWithLlm(
          summaryTurns,
          this.options.plannerModel,
        )
      : buildRecentFeedbackSummary(summaryTurns);
    const effectivePolicyState = nextPolicyState ?? currentPolicyState;
    const effectiveInsights: RelationshipMemoryInsights = {
      ...insights,
      ...(buildEffectiveContextSummary(
        recentSummary,
        effectivePolicyState?.summary,
        insights.recentContextSummary,
      )
        ? {
            recentContextSummary: buildEffectiveContextSummary(
              recentSummary,
              effectivePolicyState?.summary,
              insights.recentContextSummary,
            ),
          }
        : {}),
    };
    const planned = this.options.plannerModel
      ? await planRelationshipTasksWithLlm(
          effectiveInsights,
          this.policy,
          this.now(),
          this.options.plannerModel,
          workUnitStates,
        )
      : planRelationshipTasks(
          effectiveInsights,
          this.policy,
          this.now(),
          workUnitStates,
        );
    console.log("planned:", planned.length);
    const tasks = applyInterventionPolicyState(
      planned,
      effectivePolicyState,
    ).map(normalizeUserFacingTaskText);
    console.log("tasks:", tasks.length);
    return reconcilePlannedTasksWithWorkUnits(tasks, workUnitStates);
  }

  async dispatchTasks(input: {
    botId: string;
    threadId: string;
    userId?: string;
    channelId?: string;
  }): Promise<BackgroundInput[]> {
    if (!this.options.backgroundInputSink) {
      throw new Error(
        "backgroundInputSink is required to dispatch relationship tasks",
      );
    }
    let tasks = await this.planTasks(input);
    const organizeTasks = tasks.filter((task) => task.unitStep === "organize");
    await this.executeOrganizeTasks(organizeTasks);
    if (organizeTasks.length > 0) {
      tasks = await this.planTasks(input);
    }
    const threadKey = buildThreadKey(input.botId, input.threadId);
    const nowMs = this.now().getTime();
    if (await this.shouldSuppressForQueueBacklog()) {
      process.stdout.write(
        `[relationship-system] suppressed dispatch botId=${input.botId} threadId=${input.threadId} reason=queue_backlog\n`,
      );
      return [];
    }
    const selected = sortTasksForWorkUnitFlow(
      tasks.filter(isUserFacingTask),
    ).slice(0, this.policy.maxBackgroundInputsPerRun);
    if (
      this.shouldSuppressDispatch({
        threadKey,
        selected,
        nowMs,
      })
    ) {
      process.stdout.write(
        `[relationship-system] suppressed dispatch botId=${input.botId} threadId=${input.threadId} selected=${selected.length}\n`,
      );
      return [];
    }
    const backgroundInputs = selected.map(toBackgroundInput);
    process.stdout.write(
      `[relationship-system] planned botId=${input.botId} threadId=${input.threadId} tasks=${tasks.length} dispatch=${backgroundInputs.length}\n`,
    );
    for (const backgroundInput of backgroundInputs) {
      await this.options.backgroundInputSink.enqueue(backgroundInput);
    }
    await this.persistWorkUnitStates(tasks, selected);
    if (selected.length > 0) {
      const reportSignature =
        this.lastReportSignatureByThread.get(threadKey) ?? "";
      this.lastDispatchedReportSignatureByThread.set(
        threadKey,
        reportSignature,
      );
      this.lastDispatchedTaskFingerprintByThread.set(
        threadKey,
        buildTaskFingerprint(selected),
      );
      this.lastDispatchedAtByThread.set(threadKey, nowMs);
    }
    return backgroundInputs;
  }

  private async persistWorkUnitStates(
    plannedTasks: RelationshipTask[],
    selectedTasks: RelationshipTask[],
  ): Promise<void> {
    const nowIso = this.now().toISOString();
    const selectedUnitIds = new Set(selectedTasks.map((task) => task.unitId));
    for (const task of plannedTasks) {
      if (task.unitStep === "organize") {
        continue;
      }
      const selected = selectedUnitIds.has(task.unitId);
      if (!selected) {
        continue;
      }
      const state: RelationshipWorkUnitState = {
        unitId: task.unitId,
        botId: task.botId,
        threadId: task.threadId,
        kind: task.kind,
        title: task.title,
        currentStep: task.unitStep,
        status:
          task.unitStep === "observe" ? "waiting_for_response" : "intervened",
        sourceSignals: task.sourceSignals,
        ...(task.unitStep === "intervene"
          ? {
              lastInterventionText: task.inputText,
            }
          : {}),
        ...(task.unitStep === "observe"
          ? {
              lastObservationPrompt: task.inputText,
              responseWindowTurns: 3,
            }
          : {}),
        lastInterventionAtIso: nowIso,
        updatedAtIso: nowIso,
      };
      await this.workUnitStateStore.saveWorkUnit(state);
    }
  }

  private async executeOrganizeTasks(tasks: RelationshipTask[]): Promise<void> {
    if (tasks.length === 0) {
      return;
    }
    const nowIso = this.now().toISOString();
    for (const task of tasks) {
      const organizeSummary = this.options.plannerModel
        ? await summarizeOrganizeTaskWithLlm(task, this.options.plannerModel)
        : summarizeOrganizeTaskHeuristically(task);
      await this.workUnitStateStore.saveWorkUnit({
        unitId: task.unitId,
        botId: task.botId,
        threadId: task.threadId,
        kind: task.kind,
        title: task.title,
        currentStep: "organize",
        status: "internal_completed",
        sourceSignals: task.sourceSignals,
        organizeSummary,
        updatedAtIso: nowIso,
      });
    }
  }

  private async updateObservedWorkUnits(turn: TurnRecord): Promise<void> {
    const units = await this.workUnitStateStore.listWorkUnits({
      botId: turn.botId,
      threadId: turn.threadId,
    });
    if (units.length === 0) {
      return;
    }
    const recentTurns =
      await this.options.turnRecordStore.listRecentTurnRecords({
        botId: turn.botId,
        threadId: turn.threadId,
        limit: Math.max(8, this.recentTurnLimit + 4),
      });
    const nowIso = this.now().toISOString();
    for (const unit of units) {
      if (
        unit.status !== "waiting_for_response" ||
        !unit.lastInterventionAtIso
      ) {
        continue;
      }
      const observed = await observeFeedbackResponse(
        recentTurns,
        unit,
        this.options.plannerModel,
      );
      if (observed.kind === "pending") {
        continue;
      }
      await this.workUnitStateStore.saveWorkUnit({
        ...unit,
        currentStep: "adjust",
        status:
          observed.kind === "response_received"
            ? "response_received"
            : "no_signal",
        ...(observed.kind === "response_received" && observed.responseText
          ? {
              observedResponseText: observed.responseText,
            }
          : {}),
        updatedAtIso: nowIso,
      });
    }
  }

  private shouldSuppressDispatch(input: {
    threadKey: string;
    selected: RelationshipTask[];
    nowMs: number;
  }): boolean {
    if (input.selected.length === 0) {
      return true;
    }
    if (input.selected.some((task) => task.priority === "high")) {
      return false;
    }
    const latestTurnAt = this.latestTurnAtByThread.get(input.threadKey);
    if (
      latestTurnAt !== undefined &&
      input.nowMs - latestTurnAt < this.minTurnAgeMsBeforeLowPriorityDispatch
    ) {
      return true;
    }
    const reportSignature =
      this.lastReportSignatureByThread.get(input.threadKey) ?? "";
    const lastReportSignature =
      this.lastDispatchedReportSignatureByThread.get(input.threadKey) ?? "";
    const fingerprint = buildTaskFingerprint(input.selected);
    const lastFingerprint =
      this.lastDispatchedTaskFingerprintByThread.get(input.threadKey) ?? "";
    if (
      reportSignature &&
      reportSignature === lastReportSignature &&
      fingerprint === lastFingerprint
    ) {
      return true;
    }

    const lastAt = this.lastDispatchedAtByThread.get(input.threadKey);
    const withinWindow =
      lastAt !== undefined &&
      input.nowMs - lastAt < this.dispatchSuppressionWindowMs;
    if (!withinWindow) {
      return false;
    }
    const currentUnitSteps = new Set(
      input.selected.map((task) => `${task.unitId}:${task.unitStep}`),
    );
    const lastUnitSteps = new Set(
      (lastFingerprint ? lastFingerprint.split("|") : [])
        .map((entry) => entry.split(":").slice(0, 2).join(":"))
        .filter(Boolean),
    );
    for (const unitStep of currentUnitSteps) {
      if (lastUnitSteps.has(unitStep)) {
        return true;
      }
    }
    return false;
  }

  private async shouldSuppressForQueueBacklog(): Promise<boolean> {
    if (!this.options.queueStatusProvider) {
      return false;
    }
    const status = await this.options.queueStatusProvider();
    return (
      status.locked > 0 ||
      status.readyUser > 0 ||
      status.readyScheduled > this.maxReadyQueueTasksBeforeSuppression
    );
  }
}

export const createRelationshipSystemService = (
  options: RelationshipSystemOptions,
): RelationshipSystemService => new DefaultRelationshipSystemService(options);

const createInMemoryWorkUnitStateStore = (): RelationshipWorkUnitStateStore => {
  const items = new Map<string, RelationshipWorkUnitState[]>();
  return {
    async listWorkUnits(input) {
      return items.get(buildThreadKey(input.botId, input.threadId)) ?? [];
    },
    async saveWorkUnit(state) {
      const key = buildThreadKey(state.botId, state.threadId);
      const current = items.get(key) ?? [];
      const next = current.filter((item) => item.unitId !== state.unitId);
      next.push(state);
      items.set(key, next);
    },
  };
};

const loadScopedPolicyState = async (
  store: RelationshipPolicyStateStore | undefined,
  input: RelationshipScopeContext,
  scopeMode: "thread" | "user" | "hybrid",
  userScopeKeyResolver: (input: RelationshipScopeContext) => string | null,
  userScopeMissingUserIdMode: "fallback_thread" | "skip_user_scope",
): Promise<RelationshipInterventionPolicyState | null> => {
  if (!store) {
    return null;
  }
  const userScopeKey = resolveUserScopeKey(
    input,
    userScopeKeyResolver,
    userScopeMissingUserIdMode,
  );
  if (scopeMode === "thread") {
    const state = await store.getPolicyState(input);
    return state ? { ...state, threadId: input.threadId } : null;
  }
  if (scopeMode === "user") {
    if (!userScopeKey) {
      return null;
    }
    const key = userScopeKey;
    const state = await store.getPolicyState({
      botId: input.botId,
      threadId: key,
    });
    return state ? { ...state, threadId: input.threadId } : null;
  }
  const [userState, threadState] = await Promise.all([
    userScopeKey
      ? store.getPolicyState({ botId: input.botId, threadId: userScopeKey })
      : Promise.resolve(null),
    store.getPolicyState(input),
  ]);
  const merged = mergePolicyStates(userState, threadState);
  return merged ? { ...merged, threadId: input.threadId } : null;
};

const saveScopedPolicyState = async (
  store: RelationshipPolicyStateStore,
  state: RelationshipInterventionPolicyState,
  scopeMode: "thread" | "user" | "hybrid",
  userScopeKeyResolver: (input: RelationshipScopeContext) => string | null,
  userScopeMissingUserIdMode: "fallback_thread" | "skip_user_scope",
  scopeContext: RelationshipScopeContext,
): Promise<void> => {
  const userScopeKey = resolveUserScopeKey(
    scopeContext,
    userScopeKeyResolver,
    userScopeMissingUserIdMode,
  );
  if (scopeMode === "thread") {
    await store.savePolicyState(state);
    return;
  }
  if (scopeMode === "user") {
    if (!userScopeKey) {
      return;
    }
    await store.savePolicyState({
      ...state,
      threadId: userScopeKey,
    });
    return;
  }
  if (userScopeKey) {
    await store.savePolicyState({
      ...state,
      threadId: userScopeKey,
    });
  }
  await store.savePolicyState(state);
};

const toUserScopeThreadKey = (threadId: string): string | null => {
  const index = threadId.lastIndexOf(":");
  if (index < 0 || index === threadId.length - 1) {
    return null;
  }
  const userId = threadId.slice(index + 1).trim();
  if (!userId) {
    return null;
  }
  return `user:${userId}`;
};

const defaultUserScopeKeyResolver = (
  input: RelationshipScopeContext,
): string | null => {
  if (input.userId && input.userId.trim().length > 0) {
    return `user:${input.userId.trim()}`;
  }
  return toUserScopeThreadKey(input.threadId);
};

const resolveUserScopeKey = (
  input: RelationshipScopeContext,
  resolver: (input: RelationshipScopeContext) => string | null,
  missingUserIdMode: "fallback_thread" | "skip_user_scope",
): string | null => {
  const key = resolver(input);
  if (key && key.trim().length > 0) {
    return key.trim();
  }
  if (missingUserIdMode === "fallback_thread") {
    return input.threadId;
  }
  return null;
};

const mergePolicyStates = (
  userState: RelationshipInterventionPolicyState | null,
  threadState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionPolicyState | null => {
  if (!userState && !threadState) {
    return null;
  }
  if (!userState) {
    return threadState;
  }
  if (!threadState) {
    return userState;
  }
  return {
    ...userState,
    ...threadState,
  };
};

interface FeedbackSummaryResult {
  summary?: string;
  signals?: string[];
}

const buildEffectiveContextSummary = (
  recentSummary?: string,
  policySummary?: string,
  fallbackSummary?: string,
): string => {
  const sections = [policySummary, recentSummary, fallbackSummary]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  return sections.join("\n\n");
};

const buildRecentFeedbackSummary = (turns: TurnRecord[]): string => {
  const lines = formatRecentTurns(turns);
  if (lines.length === 0) {
    return "";
  }
  return [
    "Recent feedback-oriented conversation:",
    "Recent turns:",
    ...lines,
  ].join("\n");
};

export const buildRecentFeedbackSummaryWithLlm = async (
  turns: TurnRecord[],
  plannerModel: RelationshipPlanningModel,
): Promise<string> => {
  const lines = formatRecentTurns(turns, 10);
  if (lines.length === 0) {
    return "";
  }
  const heuristic = buildFallbackFeedbackSummary(turns);
  if (!hasRecentFeedbackProbe(turns)) {
    return heuristic;
  }
  const parsed = await plannerModel.generateJson<FeedbackSummaryResult>(
    [
      "あなたは直近の assistant-user turn から user feedback を要約します。",
      "recentTurns には assistant と user の message だけが時系列順で入っています。",
      "assistant が clarification, preference, feedback question をしたか、その後の user reply が何を示しているかに注目してください。",
      "硬直したラベル付けよりも自然言語での解釈を優先してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "recentTurns を読んでください。",
        "assistant が clarification, preference, feedback question をしている場合は、その後の user response に注目してください。",
        "user の feedback が今後の対話に何を示唆するかを要約してください。",
        "次の field を厳密に返してください:",
        "- summary: 簡潔な自然言語の要約段落",
        "- signals: 任意の短い根拠文字列",
      ].join(" "),
      recentTurns: lines,
    }),
  );

  const summary = parsed.summary?.trim();
  const signals = (parsed.signals ?? [])
    .map((signal) => signal.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!summary) {
    return heuristic;
  }
  if (signals.length === 0) {
    return `Recent feedback-oriented conversation:\n${summary}`;
  }
  return [
    "Recent feedback-oriented conversation:",
    summary,
    "Possible feedback signals:",
    ...signals.map((signal) => `- ${signal}`),
  ].join("\n");
};

const buildFallbackFeedbackSummary = (turns: TurnRecord[]): string => {
  const recentSummary = buildRecentFeedbackSummary(turns);
  if (!recentSummary) {
    return "";
  }

  const signals = turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .map((content) => {
      const signal = detectFeedbackSignal(content);
      return signal ? `${signal}: ${content}` : "";
    })
    .filter(Boolean)
    .slice(-3);

  if (signals.length === 0) {
    return recentSummary;
  }
  return [
    "Recent feedback-oriented conversation:",
    "Possible feedback signals:",
    ...signals.map((signal) => `- ${signal}`),
    "Recent turns:",
    ...formatRecentTurns(turns),
  ].join("\n");
};

const summarizeOrganizeTaskHeuristically = (task: RelationshipTask): string => {
  const source = task.sourceSignals[0] ?? task.title;
  switch (task.kind) {
    case "preference_gap":
      return `${source} について、次回はユーザーに一つだけ具体的な好みを確認する。`;
    case "stale_context":
      return `${source} を最新前提として短く整理し、必要なら先回りで共有する。`;
    case "conflict_resolution":
      return `${source} の違いを一文で説明できるように整理し、再発を防ぐ。`;
    case "memory_boundary":
      return `${source} について記憶の境界を明確にするため、短い確認文を用意する。`;
  }
};

export const summarizeOrganizeTaskWithLlm = async (
  task: RelationshipTask,
  plannerModel: RelationshipPlanningModel,
): Promise<string> => {
  if (task.sourceSignals.length <= 1) {
    return summarizeOrganizeTaskHeuristically(task);
  }
  const parsed = await plannerModel.generateJson<{ summary?: string }>(
    [
      "あなたは relationship-support Work Unit の organize step の結果を要約します。",
      "organizeStep には、完了した内部 organize step についての最小情報だけが入っています。",
      "次の user-facing intervention を導ける短い 1 文を作ってください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "organizeStep を読んでください。",
        "整理結果を、次の intervention step のための簡潔な 1 文に要約してください。",
        "厳密に { summary: string } を返してください。",
      ].join(" "),
      organizeStep: {
        kind: task.kind,
        title: task.title,
        purpose: task.purpose,
        sourceSignals: task.sourceSignals,
        inputText: task.inputText,
      },
    }),
  );
  return parsed.summary?.trim() || summarizeOrganizeTaskHeuristically(task);
};

const reconcilePlannedTasksWithWorkUnits = (
  tasks: RelationshipTask[],
  workUnits: RelationshipWorkUnitState[],
): RelationshipTask[] => {
  if (workUnits.length === 0) {
    return tasks;
  }
  const byUnitId = new Map(
    workUnits.map((unit) => [unit.unitId, unit] as const),
  );
  return tasks.filter((task) => {
    const unit = byUnitId.get(task.unitId);
    if (!unit) {
      return true;
    }
    if (unit.status === "waiting_for_response") {
      return false;
    }
    if (
      unit.currentStep === "intervene" &&
      unit.status === "intervened" &&
      task.unitStep === "intervene"
    ) {
      return false;
    }
    if (
      unit.currentStep === "organize" &&
      unit.status === "internal_completed" &&
      task.executionMode === "collect_info"
    ) {
      return false;
    }
    if (
      unit.currentStep === "adjust" &&
      (unit.status === "response_received" || unit.status === "no_signal")
    ) {
      return false;
    }
    return true;
  });
};

const sortTasksForWorkUnitFlow = (
  tasks: RelationshipTask[],
): RelationshipTask[] => {
  const order: Record<RelationshipTask["unitStep"], number> = {
    organize: 0,
    intervene: 1,
    observe: 2,
    adjust: 3,
  };
  return [...tasks].sort(
    (left, right) => order[left.unitStep] - order[right.unitStep],
  );
};

const formatRecentTurns = (turns: TurnRecord[], limit: number = 8): string[] =>
  turns
    .flatMap((turn) => turn.messages)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => `[${message.role}] ${message.content.trim()}`)
    .filter((line) => line.length > 8)
    .slice(-limit);

const detectFeedbackSignal = (content: string): string | null => {
  const value = content.toLowerCase();
  if (/(too many|多すぎ|減ら|shorter|短く|brief|簡潔)/i.test(value)) {
    return "preference_or_volume";
  }
  if (/(違う|ちがう|instead|rather|not that|修正|訂正)/i.test(value)) {
    return "correction";
  }
  if (/(好き|嫌い|prefer|preference|want|望む)/i.test(value)) {
    return "explicit_preference";
  }
  if (/(ありがとう|助かった|helpful|thanks)/i.test(value)) {
    return "positive_feedback";
  }
  if (/(わから|confusing|混乱|困る|friction|うるさい)/i.test(value)) {
    return "negative_feedback";
  }
  return null;
};

const hasRecentFeedbackProbe = (turns: TurnRecord[]): boolean =>
  turns
    .flatMap((turn) => turn.messages)
    .some(
      (message) =>
        message.role === "assistant" &&
        /(頻度|多すぎ|減ら|補足|確認).*教えて|feedback|too frequent|too many questions|reduce|確認頻度/i.test(
          message.content,
        ),
    );
