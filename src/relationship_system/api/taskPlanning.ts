import {
  BackgroundInput,
  RelationshipExecutionMode,
  RelationshipMemoryInsights,
  RelationshipPlanningModel,
  RelationshipPolicy,
  RelationshipTask,
  RelationshipWorkUnitKind,
  RelationshipWorkUnitState,
  RelationshipWorkUnitStep,
} from "../domain/types";

interface PlannedTask {
  kind?: RelationshipWorkUnitKind | string;
  unitStep?: RelationshipWorkUnitStep | string;
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

interface CandidateUnit {
  kind: RelationshipWorkUnitKind;
  source: string;
  title: string;
  purpose: string;
  priority: RelationshipTask["priority"];
  sourceSignals: string[];
}

export const planRelationshipTasks = (
  insights: RelationshipMemoryInsights,
  policy: RelationshipPolicy,
  now: Date,
  workUnits: RelationshipWorkUnitState[] = [],
): RelationshipTask[] => {
  const tasks: RelationshipTask[] = [];
  const workUnitsById = new Map(
    workUnits.map((unit) => [unit.unitId, unit] as const),
  );

  for (const candidate of deriveCandidateUnits(insights, policy)) {
    const unitId = buildUnitId(
      insights.botId,
      insights.threadId,
      candidate.kind,
      candidate.source,
    );
    const unit = workUnitsById.get(unitId);
    if (!unit) {
      tasks.push(
        createTask(insights, now, {
          unitId,
          kind: candidate.kind,
          unitStep: "organize",
          executionMode: "collect_info",
          source: candidate.source,
          title: candidate.title,
          purpose: candidate.purpose,
          inputText: buildOrganizeInstruction(candidate),
          priority: candidate.priority,
          sourceSignals: candidate.sourceSignals,
        }),
      );
      continue;
    }
    if (
      unit.currentStep === "organize" &&
      unit.status === "internal_completed"
    ) {
      tasks.push(buildInterventionTaskFromWorkUnit(insights, now, unit));
      continue;
    }
    if (
      unit.currentStep === "intervene" &&
      unit.status === "intervened" &&
      shouldPlanObservation(unit, policy)
    ) {
      tasks.push(buildObservationTaskFromWorkUnit(insights, now, unit));
    }
  }

  return tasks;
};

export const planRelationshipTasksWithLlm = async (
  insights: RelationshipMemoryInsights,
  policy: RelationshipPolicy,
  now: Date,
  plannerModel: RelationshipPlanningModel,
  workUnits: RelationshipWorkUnitState[] = [],
): Promise<RelationshipTask[]> => {
  const baseTasks = planRelationshipTasks(insights, policy, now, workUnits);
  if (baseTasks.length === 0) {
    return [];
  }
  const llmPlanned = await plannerModel.generateJson<PlannedTasksResult>(
    [
      "あなたは relationship-support system の次の Work Unit step を計画します。",
      "Work Unit は organize, intervene, observe, adjust を進む自律的な支援ループです。",
      "この planner が出力してよいのは organize, intervene, observe の task だけです。adjust task は出力してはいけません。",
      "入力には planning に必要な最小情報だけが含まれます: relationshipInsightReport, policy, existingWorkUnits, heuristicPlan。",
      "relationshipInsightReport の意味:",
      "- clarificationCandidates: 明確化する価値がある具体的なユーザーの好みや制約。",
      "- proactiveContextCandidates: 先回りして短く共有する価値がある有用な文脈やリマインド。",
      "- repairCandidates: 修復したほうがよい不一致、矛盾、摩擦の候補。",
      "- boundaryCandidates: 将来の対話のために明確化したほうがよい区別やスコープ境界。",
      "policy の意味:",
      "- proactiveHelpLevel: どの程度先回りしてよいか。",
      "- askForFeedbackSparingly: observe/feedback を控えめにすべきか。",
      "- maxBackgroundInputsPerRun: 1 回の実行でユーザー向けに出してよい介入の上限。",
      "existingWorkUnits は永続化された unit state です。unit が新規か、intervene に進めるか、observe に進めるかの判断に使ってください。",
      "kind に使える値は厳密に次の 4 つだけです: preference_gap, stale_context, conflict_resolution, memory_boundary。",
      "kind の意味:",
      "- preference_gap: 欠けているユーザーの好みを 1 つ明確化する。",
      "- stale_context: 後続支援の前に古い記憶や文脈を更新する。",
      "- conflict_resolution: 繰り返している不一致や矛盾を減らす。",
      "- memory_boundary: 記憶をきれいに保つために区別を明確化する。",
      "unitStep に使える値は厳密に次の 3 つだけです: organize, intervene, observe。",
      "unitStep の意味:",
      "- organize: 直接ユーザーには見せない内部準備や情報整理。",
      "- intervene: ユーザー向けの 1 メッセージ。質問または短い先回りの共有。",
      "- observe: 以前の介入について、頻度・有用性・スタイルを確認するユーザー向けの 1 質問。",
      "executionMode に使える値は厳密に次の 3 つだけです: collect_info, provide_info, ask_user。",
      "典型的な対応:",
      "- organize -> collect_info",
      "- intervene -> ask_user または provide_info",
      "- observe -> ask_user",
      "制約:",
      "- intervene と observe は、その step に進める準備ができている work unit に対してだけ返してください。",
      "- 介入が存在する前に、独立した feedback task を作ってはいけません。",
      "- 介入は控えめで、ユーザー向けで、sourceSignals に根拠を持たせてください。",
      "- inputText は main agent を通して送る実際の文面意図であり、内部メモではありません。",
      "- heuristicPlan がすでに妥当なら再利用し、planning context がより良い step を明確に支持する場合だけ変更してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "relationshipInsightReport, policy, existingWorkUnits, heuristicPlan を読んでください。",
        "明確な改善理由がない限り heuristicPlan に近い案を優先してください。",
        "relationshipInsightReport が示す新規 candidate work unit には organize task を作ってください。",
        "intervene task は organize step が完了済みの work unit に対してのみ作ってください。",
        "observe task は、すでに intervene 済みで、頻度や有用性の feedback を尋ねるべき work unit に対してのみ作ってください。",
        "task 配列を返してください。各 task object には次を含めてください:",
        "- kind: one of preference_gap | stale_context | conflict_resolution | memory_boundary",
        "- unitStep: one of organize | intervene | observe",
        "- executionMode: one of collect_info | provide_info | ask_user",
        "- title: 短い人間可読な task title",
        "- purpose: task の理由を 1 文で説明したもの",
        "- inputText: その step で使う具体的な文面または指示",
        "- priority: one of low | medium | high",
        "- sourceSignals: task を正当化する report item または短い根拠文字列の一覧",
      ].join(" "),
      relationshipInsightReport: {
        clarificationCandidates: insights.report.clarificationCandidates,
        proactiveContextCandidates: insights.report.proactiveContextCandidates,
        repairCandidates: insights.report.repairCandidates,
        boundaryCandidates: insights.report.boundaryCandidates,
      },
      policy: {
        proactiveHelpLevel: policy.proactiveHelpLevel,
        askForFeedbackSparingly: policy.askForFeedbackSparingly,
        maxBackgroundInputsPerRun: policy.maxBackgroundInputsPerRun,
      },
      existingWorkUnits: workUnits.map((unit) => ({
        unitId: unit.unitId,
        kind: unit.kind,
        currentStep: unit.currentStep,
        status: unit.status,
        title: unit.title,
        sourceSignals: unit.sourceSignals,
        organizeSummary: unit.organizeSummary,
        lastInterventionText: unit.lastInterventionText,
        lastObservationPrompt: unit.lastObservationPrompt,
      })),
      heuristicPlan: baseTasks.map((task) => ({
        kind: task.kind,
        unitStep: task.unitStep,
        executionMode: task.executionMode,
        title: task.title,
        purpose: task.purpose,
        inputText: task.inputText,
        priority: task.priority,
        sourceSignals: task.sourceSignals,
      })),
    }),
  );
  const tasks = (llmPlanned.tasks ?? [])
    .map((task, index) => normalizeTask(task, insights, now, index))
    .filter((task): task is RelationshipTask => task !== null);
  return tasks.length > 0 ? tasks : baseTasks;
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
    [...insights.report.clarificationCandidates].sort().join("|"),
    [...insights.report.proactiveContextCandidates].sort().join("|"),
    [...insights.report.repairCandidates].sort().join("|"),
    [...insights.report.boundaryCandidates].sort().join("|"),
  ].join("::");

export const buildTaskFingerprint = (tasks: RelationshipTask[]): string =>
  tasks
    .map(
      (task) =>
        `${task.unitId}:${task.unitStep}:${task.priority}:${task.executionMode}`,
    )
    .join("|");

export const isUserFacingTask = (task: RelationshipTask): boolean =>
  task.unitStep === "intervene" || task.unitStep === "observe";

export const normalizeUserFacingTaskText = (
  task: RelationshipTask,
): RelationshipTask => {
  if (!isUserFacingTask(task)) {
    return task;
  }
  const base = task.inputText.trim();
  if (task.unitStep === "observe") {
    return {
      ...task,
      inputText: /[?？]$/.test(base) ? base : `${base} 一言で教えてください。`,
    };
  }
  if (task.executionMode === "ask_user") {
    return {
      ...task,
      inputText:
        /[?？]$/.test(base) || /教えて|確認|どちら|どう|何/.test(base)
          ? base
          : `確認です。${base} 必要なら一言で教えてください。`,
    };
  }
  return {
    ...task,
    inputText: /^(補足です。|参考までに。)/.test(base)
      ? base
      : `補足です。${base}`,
  };
};

const deriveCandidateUnits = (
  insights: RelationshipMemoryInsights,
  policy: RelationshipPolicy,
): CandidateUnit[] => {
  const candidates: CandidateUnit[] = [];
  if (insights.report.clarificationCandidates.length > 0) {
    candidates.push({
      kind: "preference_gap",
      source: insights.report.clarificationCandidates[0] ?? "preference-gap",
      title: "Clarify one user preference",
      purpose:
        "Prepare one concrete preference clarification before the next user-facing intervention.",
      priority: "medium",
      sourceSignals: insights.report.clarificationCandidates.slice(0, 1),
    });
  }
  if (
    insights.report.proactiveContextCandidates.length > 0 &&
    policy.proactiveHelpLevel !== "low"
  ) {
    candidates.push({
      kind: "stale_context",
      source:
        insights.report.proactiveContextCandidates[0] ?? "stale-context",
      title: "Refresh stale context",
      purpose:
        "Refresh one stale context item so later interventions are grounded.",
      priority: policy.proactiveHelpLevel === "high" ? "high" : "medium",
      sourceSignals: insights.report.proactiveContextCandidates.slice(0, 1),
    });
  }
  if (insights.report.repairCandidates.length > 0) {
    candidates.push({
      kind: "conflict_resolution",
      source: insights.report.repairCandidates[0] ?? "conflict-resolution",
      title: "Resolve one recurring mismatch",
      purpose:
        "Prepare a concise boundary explanation so the assistant can proactively avoid the same mismatch.",
      priority: "high",
      sourceSignals: insights.report.repairCandidates.slice(0, 1),
    });
  }
  if (insights.report.boundaryCandidates.length > 0) {
    candidates.push({
      kind: "memory_boundary",
      source:
        insights.report.boundaryCandidates[0] ??
        "memory-boundary",
      title: "Tighten one memory boundary",
      purpose:
        "Prepare one user-facing clarification that will help the memory system keep a cleaner distinction.",
      priority: "high",
      sourceSignals: insights.report.boundaryCandidates.slice(0, 2),
    });
  }
  return candidates;
};

const shouldPlanObservation = (
  unit: RelationshipWorkUnitState,
  policy: RelationshipPolicy,
): boolean => {
  if (!policy.askForFeedbackSparingly) {
    return false;
  }
  if (unit.lastObservationPrompt) {
    return false;
  }
  return unit.kind !== "preference_gap";
};

const buildInterventionTaskFromWorkUnit = (
  insights: RelationshipMemoryInsights,
  now: Date,
  unit: RelationshipWorkUnitState,
): RelationshipTask => {
  const summary =
    unit.organizeSummary?.trim() || unit.sourceSignals[0] || unit.title;
  if (unit.kind === "preference_gap" || unit.kind === "memory_boundary") {
    return createTask(insights, now, {
      unitId: unit.unitId,
      kind: unit.kind,
      unitStep: "intervene",
      executionMode: "ask_user",
      source: `${unit.unitId}_intervene`,
      title: unit.title,
      purpose:
        "Ask the user one concrete question based on the organized context.",
      inputText: buildInterventionQuestion(unit.kind, summary),
      priority: unit.kind === "memory_boundary" ? "high" : "medium",
      sourceSignals: unit.sourceSignals,
    });
  }
  return createTask(insights, now, {
    unitId: unit.unitId,
    kind: unit.kind,
    unitStep: "intervene",
    executionMode: "provide_info",
    source: `${unit.unitId}_intervene`,
    title: unit.title,
    purpose:
      "Provide one concise user-facing intervention based on the organized context.",
    inputText: buildInterventionInfo(unit.kind, summary),
    priority: unit.kind === "conflict_resolution" ? "high" : "medium",
    sourceSignals: unit.sourceSignals,
  });
};

const buildObservationTaskFromWorkUnit = (
  insights: RelationshipMemoryInsights,
  now: Date,
  unit: RelationshipWorkUnitState,
): RelationshipTask =>
  createTask(insights, now, {
    unitId: unit.unitId,
    kind: unit.kind,
    unitStep: "observe",
    executionMode: "ask_user",
    source: `${unit.unitId}_observe`,
    title: `Check whether the ${unit.title.toLowerCase()} intervention felt appropriate`,
    purpose:
      "Ask whether the assistant's proactive intervention frequency or style felt appropriate.",
    inputText:
      "最近の確認や補足の頻度、または情報の出し方はちょうどよかったですか。多い・少ない・このままでよい、のように短く教えてください。",
    priority: "medium",
    sourceSignals: unit.sourceSignals,
  });

const buildOrganizeInstruction = (candidate: CandidateUnit): string =>
  `Organize the context for ${candidate.title}: ${candidate.sourceSignals.join(" / ")}`;

const buildInterventionQuestion = (
  kind: RelationshipWorkUnitKind,
  summary: string,
): string => {
  if (kind === "memory_boundary") {
    return `確認です。${summary} 必要なら短く教えてください。`;
  }
  return `確認です。${summary} 必要なら一言で教えてください。`;
};

const buildInterventionInfo = (
  kind: RelationshipWorkUnitKind,
  summary: string,
): string => {
  if (kind === "conflict_resolution") {
    return `補足です。${summary} 必要なら違いも短く整理してお伝えします。`;
  }
  return `補足です。${summary}`;
};

const createTask = (
  insights: RelationshipMemoryInsights,
  now: Date,
  input: {
    unitId?: string;
    kind: RelationshipWorkUnitKind;
    unitStep: RelationshipWorkUnitStep;
    executionMode: RelationshipExecutionMode;
    source: string;
    title: string;
    purpose: string;
    inputText: string;
    priority: RelationshipTask["priority"];
    sourceSignals: string[];
  },
): RelationshipTask => ({
  id: buildTaskId(
    insights.botId,
    insights.threadId,
    input.kind,
    input.unitStep,
    input.source,
  ),
  unitId:
    input.unitId ??
    buildUnitId(insights.botId, insights.threadId, input.kind, input.source),
  unitStep: input.unitStep,
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
  kind: RelationshipWorkUnitKind,
  unitStep: RelationshipWorkUnitStep,
  source: string,
): string =>
  `rel_${sanitizeIdPart(botId)}_${sanitizeIdPart(threadId)}_${kind}_${unitStep}_${sanitizeIdPart(source).slice(0, 48)}`;

const buildUnitId = (
  botId: string,
  threadId: string,
  kind: RelationshipWorkUnitKind,
  source: string,
): string =>
  `unit_${sanitizeIdPart(botId)}_${sanitizeIdPart(threadId)}_${kind}_${sanitizeIdPart(source).slice(0, 64)}`;

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
  const executionMode = normalizeExecutionMode(
    task.executionMode,
    task.unitStep,
  );
  const unitStep = normalizeUnitStep(task.unitStep, executionMode);
  return {
    id: buildTaskId(
      insights.botId,
      insights.threadId,
      kind,
      unitStep,
      `${index}_${title}`,
    ),
    unitId: buildUnitId(
      insights.botId,
      insights.threadId,
      kind,
      `${index}_${title}`,
    ),
    unitStep,
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
  value: RelationshipWorkUnitKind | string | undefined,
): RelationshipWorkUnitKind | null => {
  if (
    value === "preference_gap" ||
    value === "stale_context" ||
    value === "conflict_resolution" ||
    value === "memory_boundary"
  ) {
    return value;
  }
  return null;
};

const normalizeExecutionMode = (
  value: RelationshipExecutionMode | string | undefined,
  unitStep: PlannedTask["unitStep"],
): RelationshipExecutionMode => {
  if (
    value === "ask_user" ||
    value === "collect_info" ||
    value === "provide_info"
  ) {
    return value;
  }
  if (unitStep === "organize") {
    return "collect_info";
  }
  return unitStep === "observe" ? "ask_user" : "provide_info";
};

const normalizeUnitStep = (
  value: RelationshipWorkUnitStep | string | undefined,
  executionMode: RelationshipExecutionMode,
): RelationshipWorkUnitStep => {
  if (
    value === "organize" ||
    value === "intervene" ||
    value === "observe" ||
    value === "adjust"
  ) {
    return value;
  }
  if (executionMode === "collect_info") {
    return "organize";
  }
  return "intervene";
};

const normalizePriority = (
  value: RelationshipTask["priority"] | string | undefined,
): RelationshipTask["priority"] => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
};
