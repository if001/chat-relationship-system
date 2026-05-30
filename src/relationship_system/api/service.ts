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

export interface RelationshipSystemService {
  ingestTurnRecord(input: TurnRecord): Promise<void>;
  planTasks(input: {
    botId: string;
    threadId: string;
  }): Promise<RelationshipTask[]>;
  dispatchTasks(input: {
    botId: string;
    threadId: string;
  }): Promise<BackgroundInput[]>;
}

export interface RelationshipSystemOptions {
  turnRecordStore: RelationshipTurnRecordStore;
  policyStateStore?: RelationshipPolicyStateStore;
  memoryProvider?: RelationshipMemoryProvider;
  backgroundInputSink?: BackgroundInputSink;
  plannerModel?: RelationshipPlanningModel;
  policy?: Partial<RelationshipPolicy>;
  recentTurnLimit?: number;
  policyLearningTurnLimit?: number;
  executionModeLearningTurnLimit?: number;
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
  }

  async ingestTurnRecord(input: TurnRecord): Promise<void> {
    await this.options.turnRecordStore.appendTurnRecord(input);
  }

  async planTasks(input: {
    botId: string;
    threadId: string;
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
      this.options.policyStateStore?.getPolicyState(input) ?? Promise.resolve(null),
    ]);
    const learningTurns = recentTurns.slice(-this.policyLearningTurnLimit);
    const executionModeLearningTurns = recentTurns.slice(
      -this.executionModeLearningTurnLimit,
    );
    const summaryTurns = recentTurns.slice(-this.recentTurnLimit);

    const nextPolicyState = await learnInterventionPolicyState({
      botId: input.botId,
      threadId: input.threadId,
      now: this.now(),
      insights,
      recentTurns: learningTurns,
      executionModeLearningTurns,
      currentPolicyState,
      plannerModel: this.options.plannerModel,
    });

    if (nextPolicyState && this.options.policyStateStore) {
      await this.options.policyStateStore.savePolicyState(nextPolicyState);
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
  }): Promise<BackgroundInput[]> {
    if (!this.options.backgroundInputSink) {
      throw new Error(
        "backgroundInputSink is required to dispatch relationship tasks",
      );
    }
    const tasks = await this.planTasks(input);
    const selected = tasks.slice(0, this.policy.maxBackgroundInputsPerRun);
    const backgroundInputs = selected.map(toBackgroundInput);
    process.stdout.write(
      `[relationship-system] planned botId=${input.botId} threadId=${input.threadId} tasks=${tasks.length} dispatch=${backgroundInputs.length}\n`,
    );
    for (const backgroundInput of backgroundInputs) {
      await this.options.backgroundInputSink.enqueue(backgroundInput);
    }
    return backgroundInputs;
  }
}

export const createRelationshipSystemService = (
  options: RelationshipSystemOptions,
): RelationshipSystemService => new DefaultRelationshipSystemService(options);

export const planRelationshipTasks = (
  insights: RelationshipMemoryInsights,
  policy: RelationshipPolicy,
  now: Date,
): RelationshipTask[] => {
  const tasks: RelationshipTask[] = [];

  if (insights.report.gaps.length > 0 && policy.askForFeedbackSparingly) {
    tasks.push(
      createTask(insights, now, {
        kind: "feedback_prepare",
        executionMode: "ask_user",
        source: insights.report.gaps[0] ?? "gap",
        title: "Prepare one concise feedback check",
        purpose:
          "Clarify one missing preference without interrupting the main task too early.",
        inputText: `When this topic resumes, ask one concise clarification based on this gap: ${insights.report.gaps[0]}`,
        priority: "medium",
        sourceSignals: insights.report.gaps.slice(0, 1),
      }),
    );
  }

  if (
    insights.report.staleNotes.length > 0 &&
    policy.proactiveHelpLevel !== "low"
  ) {
    tasks.push(
      createTask(insights, now, {
        kind: "info_gathering",
        executionMode: "collect_info",
        source: insights.report.staleNotes[0] ?? "stale",
        title: "Refresh potentially stale context",
        purpose: "Prepare fresher support before the next related interaction.",
        inputText: `Before the next related exchange, refresh this potentially stale area: ${insights.report.staleNotes[0]}`,
        priority: policy.proactiveHelpLevel === "high" ? "high" : "medium",
        sourceSignals: insights.report.staleNotes.slice(0, 1),
      }),
    );
  }

  if (insights.report.conflicts.length > 0) {
    tasks.push(
      createTask(insights, now, {
        kind: "context_hint",
        executionMode: "provide_info",
        source: insights.report.conflicts[0] ?? "conflict",
        title: "Prepare a distinction hint",
        purpose:
          "Avoid repeating a known mismatch by making the boundary explicit next time.",
        inputText: `Next time this topic appears, apply a brief distinction hint based on: ${insights.report.conflicts[0]}`,
        priority: "high",
        sourceSignals: insights.report.conflicts.slice(0, 1),
      }),
    );
  }

  if (
    insights.report.conflicts.length > 0 ||
    insights.report.gaps.length > 1
  ) {
    tasks.push(
      createTask(insights, now, {
        kind: "memory_improvement",
        executionMode: "ask_user",
        source:
          insights.report.conflicts[0] ??
          insights.report.gaps[0] ??
          "memory-improvement",
        title: "Clarify a memory boundary",
        purpose:
          "Reduce future ambiguity by confirming one distinction the memory system should keep explicit.",
        inputText: `When this topic returns, confirm one distinction the memory system should preserve: ${insights.report.conflicts[0] ?? insights.report.gaps[0]}`,
        priority: insights.report.conflicts.length > 0 ? "high" : "medium",
        sourceSignals: [
          ...(insights.report.conflicts[0] ? [insights.report.conflicts[0]] : []),
          ...(insights.report.gaps[0] ? [insights.report.gaps[0]] : []),
        ],
      }),
    );
  }

  return tasks;
};

interface PlannedTask {
  kind?: RelationshipTask["kind"] | string;
  executionMode?: RelationshipExecutionMode | string;
  title?: string;
  purpose?: string;
  inputText?: string;
  priority?: RelationshipTask["priority"] | string;
  sourceSignals?: string[];
}

interface PlannedTasksResult {
  tasks?: PlannedTask[];
}

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

export const planRelationshipTasksWithLlm = async (
  insights: RelationshipMemoryInsights,
  policy: RelationshipPolicy,
  now: Date,
  plannerModel: RelationshipPlanningModel,
): Promise<RelationshipTask[]> => {
  const parsed = await plannerModel.generateJson<PlannedTasksResult>(
    [
      "You plan lightweight relationship-improvement tasks for an assistant.",
      "Prefer tasks that either improve the user relationship or improve the memory system.",
      "Use user feedback implications as the main signal, and numeric counts only as support.",
      "Keep tasks sparse and avoid intrusive interventions.",
      "Return JSON only.",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "Read the memory report and recent context summary.",
        "Decide what should be prepared next.",
        "Prefer one concise feedback task when a gap should be clarified.",
        "Use memory_improvement when the memory system itself should be refined or clarified.",
        "Return tasks[]. Each task needs kind, executionMode, title, purpose, inputText, priority, sourceSignals.",
      ].join(" "),
      policy,
      numericSignals: {
        gapCount: insights.report.gaps.length,
        staleCount: insights.report.staleNotes.length,
        conflictCount: insights.report.conflicts.length,
      },
      insights,
    }),
  );

  const tasks = (parsed.tasks ?? [])
    .map((task, index) => normalizeTask(task, insights, now, index))
    .filter((task): task is RelationshipTask => task !== null);

  return tasks.slice(0, Math.max(1, policy.maxBackgroundInputsPerRun));
};

const toBackgroundInput = (task: RelationshipTask): BackgroundInput => ({
  botId: task.botId,
  threadId: task.threadId,
  text: task.inputText,
  sourceTaskId: task.id,
});

const createTask = (
  insights: RelationshipMemoryInsights,
  now: Date,
  input: {
    kind: RelationshipTask["kind"];
    executionMode: RelationshipExecutionMode;
    source: string;
    title: string;
    purpose: string;
    inputText: string;
    priority: RelationshipTask["priority"];
    sourceSignals: string[];
  },
): RelationshipTask => ({
  id: buildTaskId(insights.botId, insights.threadId, input.kind, input.source),
  botId: insights.botId,
  threadId: insights.threadId,
  kind: input.kind,
  executionMode: input.executionMode,
  title: input.title,
  purpose: input.purpose,
  inputText: input.inputText,
  priority: input.priority,
  sourceSignals: input.sourceSignals,
  createdAtIso: now.toISOString(),
});

const buildTaskId = (
  botId: string,
  threadId: string,
  kind: RelationshipTask["kind"],
  source: string,
): string =>
  `rel_${sanitizeIdPart(botId)}_${sanitizeIdPart(threadId)}_${kind}_${sanitizeIdPart(source).slice(0, 48)}`;

const sanitizeIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const normalizeTask = (
  task: PlannedTask,
  insights: RelationshipMemoryInsights,
  now: Date,
  index: number,
): RelationshipTask | null => {
  const kind = normalizeKind(task.kind);
  const title = task.title?.trim();
  const purpose = task.purpose?.trim();
  const inputText = task.inputText?.trim();
  if (!kind || !title || !purpose || !inputText) {
    return null;
  }
  return {
    id: buildTaskId(
      insights.botId,
      insights.threadId,
      kind,
      `${index}_${title}`,
    ),
    botId: insights.botId,
    threadId: insights.threadId,
    kind,
    executionMode: normalizeExecutionMode(task.executionMode, kind),
    title,
    purpose,
    inputText,
    priority: normalizePriority(task.priority),
    sourceSignals: (task.sourceSignals ?? [])
      .map((signal) => signal.trim())
      .filter(Boolean),
    createdAtIso: now.toISOString(),
  };
};

const normalizeKind = (
  value: RelationshipTask["kind"] | string | undefined,
): RelationshipTask["kind"] | null => {
  if (
    value === "feedback_prepare" ||
    value === "info_gathering" ||
    value === "context_hint" ||
    value === "memory_improvement"
  ) {
    return value;
  }
  return null;
};

const normalizeExecutionMode = (
  value: RelationshipExecutionMode | string | undefined,
  kind: RelationshipTask["kind"],
): RelationshipExecutionMode => {
  if (
    value === "ask_user" ||
    value === "collect_info" ||
    value === "provide_info"
  ) {
    return value;
  }
  if (kind === "info_gathering") {
    return "collect_info";
  }
  if (kind === "context_hint") {
    return "provide_info";
  }
  return "ask_user";
};

const normalizePriority = (
  value: RelationshipTask["priority"] | string | undefined,
): RelationshipTask["priority"] => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
};

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
  return ["Recent feedback-oriented conversation:", "Recent turns:", ...lines].join(
    "\n",
  );
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
): Promise<Omit<RelationshipInterventionPolicyState, "botId" | "threadId" | "updatedAtIso"> | null> => {
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
): Omit<RelationshipInterventionPolicyState, "botId" | "threadId" | "updatedAtIso"> | null => {
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
      : currentPolicyState?.summary ?? "",
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
  currentPolicyState: RelationshipInterventionPolicyState | null,
  candidate: Omit<
    RelationshipInterventionPolicyState,
    "botId" | "threadId" | "updatedAtIso"
  >,
  explicitSignals?: ExplicitPreferenceSignals,
): Omit<RelationshipInterventionPolicyState, "botId" | "threadId" | "updatedAtIso"> => {
  const stabilizedFocus = stabilizeInterventionFocus(
    candidate.interventionFocus,
    insights,
    explicitSignals,
    currentPolicyState,
  );
  const preferredExecutionMode = stabilizePreferredExecutionMode(
    candidate.preferredExecutionMode,
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
      if (policyState.avoidFeedbackQuestions && task.kind === "feedback_prepare") {
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
    .filter((message) => message.role === "user" || message.role === "assistant")
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
  const preferConcisePrompts =
    /(shorter|短く|brief|簡潔|短め)/i.test(joined)
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
  explicitSignals: ExplicitPreferenceSignals | undefined,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionFocus => {
  if (explicitSignals?.relationshipFocusSignal) {
    return "relationship";
  }
  if (insights.report.conflicts.length > 0 || insights.report.staleNotes.length > 0) {
    return "memory";
  }
  if (currentPolicyState?.interventionFocus) {
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
  if (
    value === "balanced" ||
    value === "relationship" ||
    value === "memory"
  ) {
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
  if (insights.report.conflicts.length > 0 || insights.report.staleNotes.length > 0) {
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
      ? ["feedback_prepare", "context_hint", "memory_improvement", "info_gathering"]
      : ["memory_improvement", "info_gathering", "context_hint", "feedback_prepare"];
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
  return [...tasks].sort(
    (left, right) =>
      order.indexOf(left.executionMode) - order.indexOf(right.executionMode),
  );
};

const buildExecutionModeOrder = (
  policyState: RelationshipInterventionPolicyState,
): RelationshipExecutionMode[] => {
  if (policyState.preferredExecutionMode !== "balanced") {
    return [
      policyState.preferredExecutionMode,
      ...(["ask_user", "provide_info", "collect_info"] as RelationshipExecutionMode[]).filter(
        (mode) => mode !== policyState.preferredExecutionMode,
      ),
    ];
  }
  if (policyState.avoidFeedbackQuestions) {
    return ["provide_info", "collect_info", "ask_user"];
  }
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
  explicitSignals: ExplicitPreferenceSignals | undefined,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipExecutionModePreference => {
  if (explicitSignals?.preferredExecutionMode) {
    return explicitSignals.preferredExecutionMode;
  }
  if (candidate !== "balanced") {
    return candidate;
  }
  return currentPolicyState?.preferredExecutionMode ?? "balanced";
};
