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
} from "../domain/types";
import {
  buildMemoryReportSignature,
  buildTaskFingerprint,
  buildThreadKey,
  planRelationshipTasks,
  planRelationshipTasksWithLlm,
  toBackgroundInput,
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
  now?: () => Date;
}

const DEFAULT_POLICY: RelationshipPolicy = {
  proactiveHelpLevel: "medium",
  askForFeedbackSparingly: true,
  maxBackgroundInputsPerRun: 1,
};

class DefaultRelationshipSystemService implements RelationshipSystemService {
  private readonly policy: RelationshipPolicy;
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
  }

  async ingestTurnRecord(input: TurnRecord): Promise<void> {
    await this.options.turnRecordStore.appendTurnRecord(input);
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
    const [insights, recentTurns, currentPolicyState] = await Promise.all([
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
    ]);
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
        )
      : planRelationshipTasks(effectiveInsights, this.policy, this.now());

    return applyInterventionPolicyState(planned, effectivePolicyState);
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
    const tasks = await this.planTasks(input);
    const threadKey = buildThreadKey(input.botId, input.threadId);
    const nowMs = this.now().getTime();
    const selected = tasks.slice(0, this.policy.maxBackgroundInputsPerRun);
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
}

export const createRelationshipSystemService = (
  options: RelationshipSystemOptions,
): RelationshipSystemService => new DefaultRelationshipSystemService(options);

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

interface LearnedPolicyStateResult {
  summary?: string;
  interventionFocus?: RelationshipInterventionFocus | string;
  preferredExecutionMode?: RelationshipExecutionModePreference | string;
  avoidFeedbackQuestions?: boolean;
  preferConcisePrompts?: boolean;
  proactiveInfoPreference?: ProactiveInfoPreference | string;
}

interface ExplicitPreferenceSignals {
  avoidFeedbackQuestions?: boolean;
  preferConcisePrompts?: boolean;
  proactiveInfoPreference?: ProactiveInfoPreference;
  relationshipFocusSignal: boolean;
  preferredExecutionMode?: RelationshipExecutionModePreference;
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

const buildRecentFeedbackSummaryWithLlm = async (
  turns: TurnRecord[],
  plannerModel: RelationshipPlanningModel,
): Promise<string> => {
  const lines = formatRecentTurns(turns, 10);
  if (lines.length === 0) {
    return "";
  }
  const heuristic = buildFallbackFeedbackSummary(turns);
  const parsed = await plannerModel.generateJson<FeedbackSummaryResult>(
    [
      "You analyze recent assistant-user turns to extract user feedback.",
      "Focus on whether the assistant asked a clarification or preference question and what the user's response implies.",
      "Prefer natural-language interpretation over rigid labels.",
      "Return JSON only.",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "Read the recent assistant and user turns.",
        "If the assistant asked a clarification, preference, or feedback question, focus on the user's following response.",
        "Summarize what the user's feedback implies for future interaction.",
        "Return summary as a concise natural-language paragraph and optional signals[].",
      ].join(" "),
      recentTurns: lines.join("\n"),
      fallbackHeuristicSummary: heuristic,
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

const learnInterventionPolicyState = async (input: {
  botId: string;
  threadId: string;
  now: Date;
  minPolicyFlipIntervalMs: number;
  insights: RelationshipMemoryInsights;
  recentTurns: TurnRecord[];
  executionModeLearningTurns: TurnRecord[];
  currentPolicyState: RelationshipInterventionPolicyState | null;
  plannerModel?: RelationshipPlanningModel;
}): Promise<RelationshipInterventionPolicyState | null> => {
  if (input.recentTurns.length === 0) {
    return input.currentPolicyState;
  }
  if (input.plannerModel) {
    const [learned, preferredExecutionMode] = await Promise.all([
      learnInterventionPolicyStateWithLlm(
        input.insights,
        input.recentTurns,
        input.currentPolicyState,
        input.plannerModel,
      ),
      learnPreferredExecutionModeWithLlm(
        input.executionModeLearningTurns,
        input.currentPolicyState,
        input.plannerModel,
      ),
    ]);
    if (learned || preferredExecutionMode) {
      const stabilized = stabilizeInterventionPolicyState(
        input.insights,
        input.now,
        input.minPolicyFlipIntervalMs,
        input.currentPolicyState,
        {
          summary: learned?.summary ?? input.currentPolicyState?.summary ?? "",
          interventionFocus:
            learned?.interventionFocus ??
            input.currentPolicyState?.interventionFocus ??
            "balanced",
          preferredExecutionMode:
            preferredExecutionMode ??
            learned?.preferredExecutionMode ??
            input.currentPolicyState?.preferredExecutionMode ??
            "balanced",
          avoidFeedbackQuestions:
            learned?.avoidFeedbackQuestions ??
            input.currentPolicyState?.avoidFeedbackQuestions ??
            false,
          preferConcisePrompts:
            learned?.preferConcisePrompts ??
            input.currentPolicyState?.preferConcisePrompts ??
            false,
          proactiveInfoPreference:
            learned?.proactiveInfoPreference ??
            input.currentPolicyState?.proactiveInfoPreference ??
            "unknown",
        },
      );
      return {
        botId: input.botId,
        threadId: input.threadId,
        updatedAtIso: input.now.toISOString(),
        ...stabilized,
      };
    }
  }
  const heuristic = learnInterventionPolicyStateHeuristically(
    input.insights,
    input.recentTurns,
    input.currentPolicyState,
  );
  const heuristicPreferredExecutionMode =
    learnPreferredExecutionModeHeuristically(
      input.executionModeLearningTurns,
      input.currentPolicyState,
    );
  if (!heuristic && !heuristicPreferredExecutionMode) {
    return input.currentPolicyState;
  }
  const stabilized = stabilizeInterventionPolicyState(
    input.insights,
    input.now,
    input.minPolicyFlipIntervalMs,
    input.currentPolicyState,
    {
      summary: heuristic?.summary ?? input.currentPolicyState?.summary ?? "",
      interventionFocus:
        heuristic?.interventionFocus ??
        input.currentPolicyState?.interventionFocus ??
        "balanced",
      preferredExecutionMode:
        heuristicPreferredExecutionMode ??
        heuristic?.preferredExecutionMode ??
        input.currentPolicyState?.preferredExecutionMode ??
        "balanced",
      avoidFeedbackQuestions:
        heuristic?.avoidFeedbackQuestions ??
        input.currentPolicyState?.avoidFeedbackQuestions ??
        false,
      preferConcisePrompts:
        heuristic?.preferConcisePrompts ??
        input.currentPolicyState?.preferConcisePrompts ??
        false,
      proactiveInfoPreference:
        heuristic?.proactiveInfoPreference ??
        input.currentPolicyState?.proactiveInfoPreference ??
        "unknown",
    },
    detectExplicitPreferenceSignals(
      input.recentTurns
        .flatMap((turn) => turn.messages)
        .filter((message) => message.role === "user")
        .map((message) => message.content.trim())
        .filter(Boolean),
    ),
  );
  return {
    botId: input.botId,
    threadId: input.threadId,
    updatedAtIso: input.now.toISOString(),
    ...stabilized,
  };
};

const learnInterventionPolicyStateWithLlm = async (
  insights: RelationshipMemoryInsights,
  turns: TurnRecord[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
  plannerModel: RelationshipPlanningModel,
): Promise<Omit<
  RelationshipInterventionPolicyState,
  "botId" | "threadId" | "updatedAtIso"
> | null> => {
  const lines = formatRecentTurns(turns, 10);
  if (lines.length === 0) {
    return null;
  }
  const parsed = await plannerModel.generateJson<LearnedPolicyStateResult>(
    [
      "You update a lightweight intervention policy for an assistant.",
      "Decide whether the assistant should focus on relationship improvement, memory improvement, or keep a balanced approach.",
      "Decide which execution mode currently appears most effective: ask_user, collect_info, provide_info, or balanced.",
      "Also decide whether the assistant should reduce feedback questions, keep prompts concise, and avoid or allow proactive information.",
      "Return JSON only.",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "Read the recent turns, the memory insights, and the current policy summary.",
        "Infer whether the next background intervention should focus more on relationship improvement, memory improvement, or stay balanced.",
        "Infer which execution mode currently seems most effective: ask_user, collect_info, provide_info, or balanced.",
        "Infer the user's preference about prompting frequency, prompt conciseness, and proactive information.",
        "Return summary, interventionFocus, preferredExecutionMode, avoidFeedbackQuestions, preferConcisePrompts, proactiveInfoPreference.",
      ].join(" "),
      insights,
      currentPolicyState,
      recentTurns: lines.join("\n"),
    }),
  );

  const summary = parsed.summary?.trim();
  if (!summary) {
    return null;
  }
  return {
    summary,
    interventionFocus: normalizeInterventionFocus(parsed.interventionFocus),
    preferredExecutionMode: normalizeExecutionModePreference(
      parsed.preferredExecutionMode,
    ),
    avoidFeedbackQuestions: Boolean(parsed.avoidFeedbackQuestions),
    preferConcisePrompts: Boolean(parsed.preferConcisePrompts),
    proactiveInfoPreference: normalizeProactiveInfoPreference(
      parsed.proactiveInfoPreference,
    ),
  };
};

const learnPreferredExecutionModeWithLlm = async (
  turns: TurnRecord[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
  plannerModel: RelationshipPlanningModel,
): Promise<RelationshipExecutionModePreference | null> => {
  const lines = formatRecentTurns(turns, 16);
  if (lines.length === 0) {
    return null;
  }
  const parsed = await plannerModel.generateJson<{
    preferredExecutionMode?: RelationshipExecutionModePreference | string;
  }>(
    [
      "You infer which execution mode currently seems most effective for relationship-support tasks.",
      "Choose one of: ask_user, collect_info, provide_info, balanced.",
      "Return JSON only.",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "Read the recent turns and the current policy state.",
        "Infer which execution mode currently appears most effective over this longer span.",
        "Return preferredExecutionMode.",
      ].join(" "),
      currentPolicyState,
      recentTurns: lines.join("\n"),
    }),
  );
  if (parsed.preferredExecutionMode === undefined) {
    return null;
  }
  return normalizeExecutionModePreference(parsed.preferredExecutionMode);
};

const learnInterventionPolicyStateHeuristically = (
  insights: RelationshipMemoryInsights,
  turns: TurnRecord[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
): Omit<
  RelationshipInterventionPolicyState,
  "botId" | "threadId" | "updatedAtIso"
> | null => {
  const userMessages = turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);

  const explicitSignals = detectExplicitPreferenceSignals(userMessages);
  const interventionFocus = decideInterventionFocusHeuristically(
    insights,
    explicitSignals,
    currentPolicyState,
  );
  const preferredExecutionMode =
    explicitSignals.preferredExecutionMode ??
    currentPolicyState?.preferredExecutionMode ??
    "balanced";

  const summaryParts = [
    interventionFocus === "relationship"
      ? "Prefer relationship-improvement interventions first."
      : interventionFocus === "memory"
        ? "Prefer memory-improvement interventions first."
        : currentPolicyState?.interventionFocus === "relationship"
          ? "Keep favoring relationship-improvement interventions."
          : currentPolicyState?.interventionFocus === "memory"
            ? "Keep favoring memory-improvement interventions."
            : "",
    explicitSignals.avoidFeedbackQuestions === true
      ? "The user prefers fewer feedback questions."
      : explicitSignals.avoidFeedbackQuestions === false
        ? "The user appears open to occasional feedback questions."
        : currentPolicyState?.avoidFeedbackQuestions
          ? "The user still appears to prefer fewer feedback questions."
          : "",
    explicitSignals.preferConcisePrompts === true
      ? "The user prefers concise prompts."
      : explicitSignals.preferConcisePrompts === false
        ? "The user appears comfortable with more detailed prompts."
        : currentPolicyState?.preferConcisePrompts
          ? "The user still appears to prefer concise prompts."
          : "",
    explicitSignals.proactiveInfoPreference === "avoid"
      ? "Avoid proactive information unless clearly useful."
      : explicitSignals.proactiveInfoPreference === "allow"
        ? "Proactive information is welcome when useful."
        : preferredExecutionMode === "ask_user"
          ? "Direct user questions appear effective when needed."
          : preferredExecutionMode === "provide_info"
            ? "Brief proactive information appears effective."
            : preferredExecutionMode === "collect_info"
              ? "Background information collection appears effective."
              : (currentPolicyState?.summary ?? ""),
  ].filter(Boolean);

  if (summaryParts.length === 0) {
    return null;
  }

  return {
    summary: summaryParts.join(" "),
    interventionFocus,
    preferredExecutionMode,
    avoidFeedbackQuestions:
      explicitSignals.avoidFeedbackQuestions ??
      currentPolicyState?.avoidFeedbackQuestions ??
      false,
    preferConcisePrompts:
      explicitSignals.preferConcisePrompts ??
      currentPolicyState?.preferConcisePrompts ??
      false,
    proactiveInfoPreference:
      explicitSignals.proactiveInfoPreference ??
      currentPolicyState?.proactiveInfoPreference ??
      "unknown",
  };
};

const learnPreferredExecutionModeHeuristically = (
  turns: TurnRecord[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipExecutionModePreference | null => {
  const userMessages = turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const explicitSignals = detectExplicitPreferenceSignals(userMessages);
  if (explicitSignals.preferredExecutionMode) {
    return explicitSignals.preferredExecutionMode;
  }
  return currentPolicyState?.preferredExecutionMode ?? null;
};

const stabilizeInterventionPolicyState = (
  insights: RelationshipMemoryInsights,
  now: Date,
  minPolicyFlipIntervalMs: number,
  currentPolicyState: RelationshipInterventionPolicyState | null,
  candidate: Omit<
    RelationshipInterventionPolicyState,
    "botId" | "threadId" | "updatedAtIso"
  >,
  explicitSignals?: ExplicitPreferenceSignals,
): Omit<
  RelationshipInterventionPolicyState,
  "botId" | "threadId" | "updatedAtIso"
> => {
  const stabilizedFocus = stabilizeInterventionFocus(
    candidate.interventionFocus,
    insights,
    now,
    minPolicyFlipIntervalMs,
    explicitSignals,
    currentPolicyState,
  );
  const preferredExecutionMode = stabilizePreferredExecutionMode(
    candidate.preferredExecutionMode,
    now,
    minPolicyFlipIntervalMs,
    explicitSignals,
    currentPolicyState,
  );
  const avoidFeedbackQuestions =
    explicitSignals?.avoidFeedbackQuestions ??
    candidate.avoidFeedbackQuestions ??
    currentPolicyState?.avoidFeedbackQuestions ??
    false;
  const preferConcisePrompts =
    explicitSignals?.preferConcisePrompts ??
    candidate.preferConcisePrompts ??
    currentPolicyState?.preferConcisePrompts ??
    false;
  const proactiveInfoPreference =
    explicitSignals?.proactiveInfoPreference ??
    candidate.proactiveInfoPreference ??
    currentPolicyState?.proactiveInfoPreference ??
    "unknown";

  return {
    summary: buildPolicyStateSummary({
      summary: candidate.summary,
      interventionFocus: stabilizedFocus,
      preferredExecutionMode,
      avoidFeedbackQuestions,
      preferConcisePrompts,
      proactiveInfoPreference,
    }),
    interventionFocus: stabilizedFocus,
    preferredExecutionMode,
    avoidFeedbackQuestions,
    preferConcisePrompts,
    proactiveInfoPreference,
  };
};

const applyInterventionPolicyState = (
  tasks: RelationshipTask[],
  policyState: RelationshipInterventionPolicyState | null,
): RelationshipTask[] => {
  if (!policyState) {
    return tasks;
  }
  const filtered = tasks
    .filter((task) => {
      if (
        policyState.avoidFeedbackQuestions &&
        task.kind === "feedback_prepare"
      ) {
        return false;
      }
      if (
        policyState.proactiveInfoPreference === "avoid" &&
        task.kind === "info_gathering"
      ) {
        return false;
      }
      return true;
    })
    .map((task) => {
      if (!policyState.preferConcisePrompts) {
        return task;
      }
      if (task.executionMode === "ask_user") {
        return {
          ...task,
          inputText: `${task.inputText} Keep it to one short sentence.`,
        };
      }
      if (task.executionMode === "provide_info") {
        return {
          ...task,
          inputText: `${task.inputText} Keep it brief.`,
        };
      }
      return task;
    });

  return sortTasksByPolicyState(filtered, policyState);
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

const detectExplicitPreferenceSignals = (
  userMessages: string[],
): ExplicitPreferenceSignals => {
  const joined = userMessages.join("\n");
  const avoidFeedbackQuestions =
    /(too many|多すぎ|減ら|うるさい|no more questions)/i.test(joined)
      ? true
      : /(質問して|確認して|聞いて).*(大丈夫|ok|ください|欲しい)|質問は.*(大丈夫|歓迎)/i.test(
            joined,
          )
        ? false
        : undefined;
  const preferConcisePrompts = /(shorter|短く|brief|簡潔|短め)/i.test(joined)
    ? true
    : /(詳しく|詳細|丁寧|長め|more detail|detailed)/i.test(joined)
      ? false
      : undefined;
  const proactiveInfoPreference =
    /(not now|不要|いらない|later|今は.*不要)/i.test(joined)
      ? "avoid"
      : /(先回り|補足|追加情報|積極的).*(ほしい|欲しい|歓迎|助か)|追加情報.*あると.*助か|どんどん.*教えて/i.test(
            joined,
          )
        ? "allow"
        : undefined;
  const preferredExecutionMode =
    /(確認して|質問して|聞いて).*(助か|歓迎|大丈夫|ほしい|欲しい)/i.test(joined)
      ? "ask_user"
      : /(追加情報|補足|先回り).*(助か|歓迎|ほしい|欲しい)/i.test(joined)
        ? "provide_info"
        : /(調べて|整理して|集めて).*(助か|歓迎|ほしい|欲しい)/i.test(joined)
          ? "collect_info"
          : undefined;
  return {
    avoidFeedbackQuestions,
    preferConcisePrompts,
    proactiveInfoPreference,
    relationshipFocusSignal:
      avoidFeedbackQuestions !== undefined ||
      preferConcisePrompts !== undefined ||
      proactiveInfoPreference !== undefined,
    preferredExecutionMode,
  };
};

const stabilizeInterventionFocus = (
  candidate: RelationshipInterventionFocus,
  insights: RelationshipMemoryInsights,
  now: Date,
  minPolicyFlipIntervalMs: number,
  explicitSignals: ExplicitPreferenceSignals | undefined,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionFocus => {
  if (explicitSignals?.relationshipFocusSignal) {
    return "relationship";
  }
  if (
    insights.report.conflicts.length > 0 ||
    insights.report.staleNotes.length > 0
  ) {
    return "memory";
  }
  if (currentPolicyState?.interventionFocus) {
    if (
      candidate !== currentPolicyState.interventionFocus &&
      !isPolicyFlipAllowed(now, currentPolicyState, minPolicyFlipIntervalMs)
    ) {
      return currentPolicyState.interventionFocus;
    }
    return currentPolicyState.interventionFocus;
  }
  return candidate;
};

const buildPolicyStateSummary = (state: {
  summary?: string;
  interventionFocus: RelationshipInterventionFocus;
  preferredExecutionMode: RelationshipExecutionModePreference;
  avoidFeedbackQuestions: boolean;
  preferConcisePrompts: boolean;
  proactiveInfoPreference: ProactiveInfoPreference;
}): string => {
  const parts = [
    state.interventionFocus === "relationship"
      ? "Prefer relationship-improvement interventions first."
      : state.interventionFocus === "memory"
        ? "Prefer memory-improvement interventions first."
        : "Keep relationship and memory interventions balanced.",
    state.avoidFeedbackQuestions
      ? "The user prefers fewer feedback questions."
      : "Occasional feedback questions are acceptable.",
    state.preferConcisePrompts
      ? "The user prefers concise prompts."
      : "Detailed prompts are acceptable when useful.",
    state.preferredExecutionMode === "ask_user"
      ? "Direct user questions currently appear effective."
      : state.preferredExecutionMode === "provide_info"
        ? "Brief proactive information currently appears effective."
        : state.preferredExecutionMode === "collect_info"
          ? "Background information collection currently appears effective."
          : "",
    state.proactiveInfoPreference === "avoid"
      ? "Avoid proactive information unless clearly useful."
      : state.proactiveInfoPreference === "allow"
        ? "Proactive information is welcome when useful."
        : "",
    state.summary?.trim() ?? "",
  ].filter(Boolean);
  return Array.from(new Set(parts)).join(" ");
};

const normalizeProactiveInfoPreference = (
  value: ProactiveInfoPreference | string | undefined,
): ProactiveInfoPreference => {
  if (value === "allow" || value === "avoid" || value === "unknown") {
    return value;
  }
  return "unknown";
};

const normalizeInterventionFocus = (
  value: RelationshipInterventionFocus | string | undefined,
): RelationshipInterventionFocus => {
  if (value === "balanced" || value === "relationship" || value === "memory") {
    return value;
  }
  return "balanced";
};

const normalizeExecutionModePreference = (
  value: RelationshipExecutionModePreference | string | undefined,
): RelationshipExecutionModePreference => {
  if (
    value === "balanced" ||
    value === "ask_user" ||
    value === "collect_info" ||
    value === "provide_info"
  ) {
    return value;
  }
  return "balanced";
};

const decideInterventionFocusHeuristically = (
  insights: RelationshipMemoryInsights,
  explicitSignals: ExplicitPreferenceSignals,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionFocus => {
  if (explicitSignals.relationshipFocusSignal) {
    return "relationship";
  }
  if (
    insights.report.conflicts.length > 0 ||
    insights.report.staleNotes.length > 0
  ) {
    return "memory";
  }
  return currentPolicyState?.interventionFocus ?? "balanced";
};

const sortTasksByPolicyState = (
  tasks: RelationshipTask[],
  policyState: RelationshipInterventionPolicyState,
): RelationshipTask[] => {
  const focus = policyState.interventionFocus;
  if (focus === "balanced") {
    return sortTasksByExecutionModePreference(tasks, policyState);
  }
  const order =
    focus === "relationship"
      ? [
          "feedback_prepare",
          "context_hint",
          "memory_improvement",
          "info_gathering",
        ]
      : [
          "memory_improvement",
          "info_gathering",
          "context_hint",
          "feedback_prepare",
        ];
  return sortTasksByExecutionModePreference(
    [...tasks].sort(
      (left, right) => order.indexOf(left.kind) - order.indexOf(right.kind),
    ),
    policyState,
  );
};

const sortTasksByExecutionModePreference = (
  tasks: RelationshipTask[],
  policyState: RelationshipInterventionPolicyState,
): RelationshipTask[] => {
  const order = buildExecutionModeOrder(policyState);
  const preferredIndex =
    policyState.preferredExecutionMode === "balanced"
      ? -1
      : order.indexOf(policyState.preferredExecutionMode);
  return [...tasks].sort((left, right) => {
    const leftRank = order.indexOf(left.executionMode);
    const rightRank = order.indexOf(right.executionMode);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    if (preferredIndex < 0) {
      return 0;
    }
    const leftPreferred = left.executionMode === order[preferredIndex];
    const rightPreferred = right.executionMode === order[preferredIndex];
    if (leftPreferred === rightPreferred) {
      return 0;
    }
    return leftPreferred ? -1 : 1;
  });
};

const buildExecutionModeOrder = (
  policyState: RelationshipInterventionPolicyState,
): RelationshipExecutionMode[] => {
  // Hard guard: when feedback questions should be minimized, ask_user always trails.
  if (policyState.avoidFeedbackQuestions) {
    return ["provide_info", "collect_info", "ask_user"];
  }
  // Focus drives the primary ordering; preferredExecutionMode is a tie-breaker.
  if (policyState.proactiveInfoPreference === "avoid") {
    return ["ask_user", "collect_info", "provide_info"];
  }
  if (policyState.interventionFocus === "memory") {
    return ["collect_info", "ask_user", "provide_info"];
  }
  if (policyState.interventionFocus === "relationship") {
    return ["ask_user", "provide_info", "collect_info"];
  }
  return ["ask_user", "provide_info", "collect_info"];
};

const stabilizePreferredExecutionMode = (
  candidate: RelationshipExecutionModePreference,
  now: Date,
  minPolicyFlipIntervalMs: number,
  explicitSignals: ExplicitPreferenceSignals | undefined,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipExecutionModePreference => {
  if (explicitSignals?.preferredExecutionMode) {
    return explicitSignals.preferredExecutionMode;
  }
  if (candidate !== "balanced") {
    if (
      currentPolicyState?.preferredExecutionMode &&
      candidate !== currentPolicyState.preferredExecutionMode &&
      !isPolicyFlipAllowed(now, currentPolicyState, minPolicyFlipIntervalMs)
    ) {
      return currentPolicyState.preferredExecutionMode;
    }
    return candidate;
  }
  return currentPolicyState?.preferredExecutionMode ?? "balanced";
};

const isPolicyFlipAllowed = (
  now: Date,
  currentPolicyState: RelationshipInterventionPolicyState,
  minPolicyFlipIntervalMs: number,
): boolean => {
  if (minPolicyFlipIntervalMs <= 0) {
    return true;
  }
  const lastUpdatedMs = Date.parse(currentPolicyState.updatedAtIso);
  if (!Number.isFinite(lastUpdatedMs)) {
    return true;
  }
  return now.getTime() - lastUpdatedMs >= minPolicyFlipIntervalMs;
};
