import {
  BackgroundInput,
  RelationshipExecutionMode,
  RelationshipMemoryInsights,
  RelationshipPlanningModel,
  RelationshipPolicy,
  RelationshipTask,
} from "../domain/types";

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

  if (insights.report.conflicts.length > 0 || insights.report.gaps.length > 1) {
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
          ...(insights.report.conflicts[0]
            ? [insights.report.conflicts[0]]
            : []),
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

export const toBackgroundInput = (task: RelationshipTask): BackgroundInput => ({
  botId: task.botId,
  threadId: task.threadId,
  text: task.inputText,
  sourceTaskId: task.id,
  sourceUnitId: task.unitId,
  sourceUnitStep: task.unitStep,
});

export const buildThreadKey = (botId: string, threadId: string): string =>
  `${botId}:${threadId}`;

export const buildMemoryReportSignature = (
  insights: RelationshipMemoryInsights,
): string =>
  [
    [...insights.report.gaps].sort().join("|"),
    [...insights.report.staleNotes].sort().join("|"),
    [...insights.report.conflicts].sort().join("|"),
  ].join("::");

export const buildTaskFingerprint = (tasks: RelationshipTask[]): string =>
  tasks
    .map(
      (task) =>
        `${task.unitId}:${task.unitStep}:${task.priority}:${task.executionMode}`,
    )
    .join("|");

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
  unitId: buildUnitId(insights.botId, insights.threadId, input.source),
  unitStep: resolveUnitStep(input.executionMode),
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

const buildUnitId = (botId: string, threadId: string, source: string): string =>
  `unit_${sanitizeIdPart(botId)}_${sanitizeIdPart(threadId)}_${sanitizeIdPart(source).slice(0, 64)}`;

const resolveUnitStep = (
  executionMode: RelationshipExecutionMode,
): RelationshipTask["unitStep"] => {
  if (executionMode === "collect_info") {
    return "organize";
  }
  if (executionMode === "provide_info" || executionMode === "ask_user") {
    return "intervene";
  }
  return "adjust";
};

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
  const executionMode = normalizeExecutionMode(task.executionMode, kind);
  return {
    id: buildTaskId(
      insights.botId,
      insights.threadId,
      kind,
      `${index}_${title}`,
    ),
    unitId: buildUnitId(insights.botId, insights.threadId, `${index}_${title}`),
    unitStep: resolveUnitStep(executionMode),
    botId: insights.botId,
    threadId: insights.threadId,
    kind,
    executionMode,
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
