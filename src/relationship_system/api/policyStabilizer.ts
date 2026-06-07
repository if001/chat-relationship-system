import {
  ProactiveInfoPreference,
  RelationshipExecutionMode,
  RelationshipExecutionModePreference,
  RelationshipInterventionFocus,
  RelationshipInterventionPolicyState,
  RelationshipTask,
} from "../domain/types";
import { ExplicitPreferenceSignals } from "./observeAdjust";

export const stabilizeInterventionPolicyState = (
  now: Date,
  minPolicyFlipIntervalMs: number,
  currentPolicyState: RelationshipInterventionPolicyState | null,
  candidate: Omit<
    RelationshipInterventionPolicyState,
    "botId" | "threadId" | "updatedAtIso"
  >,
  input: {
    hasMemoryPressure: boolean;
    explicitSignals?: ExplicitPreferenceSignals;
  },
): Omit<
  RelationshipInterventionPolicyState,
  "botId" | "threadId" | "updatedAtIso"
> => {
  const stabilizedFocus = stabilizeInterventionFocus(
    candidate.interventionFocus,
    input.hasMemoryPressure,
    now,
    minPolicyFlipIntervalMs,
    input.explicitSignals,
    currentPolicyState,
  );
  const preferredExecutionMode = stabilizePreferredExecutionMode(
    candidate.preferredExecutionMode,
    now,
    minPolicyFlipIntervalMs,
    input.explicitSignals,
    currentPolicyState,
  );
  const avoidFeedbackQuestions =
    input.explicitSignals?.avoidFeedbackQuestions ??
    candidate.avoidFeedbackQuestions ??
    currentPolicyState?.avoidFeedbackQuestions ??
    false;
  const preferConcisePrompts =
    input.explicitSignals?.preferConcisePrompts ??
    candidate.preferConcisePrompts ??
    currentPolicyState?.preferConcisePrompts ??
    false;
  const proactiveInfoPreference =
    input.explicitSignals?.proactiveInfoPreference ??
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

export const sortTasksByPolicyState = (
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
          "preference_gap",
          "conflict_resolution",
          "memory_boundary",
          "stale_context",
        ]
      : [
          "stale_context",
          "memory_boundary",
          "conflict_resolution",
          "preference_gap",
        ];
  return sortTasksByExecutionModePreference(
    [...tasks].sort(
      (left, right) => order.indexOf(left.kind) - order.indexOf(right.kind),
    ),
    policyState,
  );
};

export const normalizeProactiveInfoPreference = (
  value: ProactiveInfoPreference | string | undefined,
): ProactiveInfoPreference => {
  if (value === "allow" || value === "avoid" || value === "unknown") {
    return value;
  }
  return "unknown";
};

export const normalizeInterventionFocus = (
  value: RelationshipInterventionFocus | string | undefined,
): RelationshipInterventionFocus => {
  if (value === "balanced" || value === "relationship" || value === "memory") {
    return value;
  }
  return "balanced";
};

export const normalizeExecutionModePreference = (
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

const stabilizeInterventionFocus = (
  candidate: RelationshipInterventionFocus,
  hasMemoryPressure: boolean,
  now: Date,
  minPolicyFlipIntervalMs: number,
  explicitSignals: ExplicitPreferenceSignals | undefined,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionFocus => {
  if (explicitSignals?.relationshipFocusSignal) {
    return "relationship";
  }
  if (hasMemoryPressure) {
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
