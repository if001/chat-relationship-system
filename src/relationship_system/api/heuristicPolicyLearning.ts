import {
  RelationshipExecutionModePreference,
  RelationshipInterventionPolicyState,
  RelationshipInterventionFocus,
  RelationshipMemoryInsights,
  RelationshipWorkUnitState,
  TurnRecord,
} from "../domain/types";
import {
  detectExplicitPreferenceSignals,
  extractObservedFeedbackResponses,
} from "./observeAdjust";

export const learnInterventionPolicyStateHeuristically = (
  insights: RelationshipMemoryInsights,
  turns: TurnRecord[],
  workUnitStates: RelationshipWorkUnitState[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
): Omit<
  RelationshipInterventionPolicyState,
  "botId" | "threadId" | "updatedAtIso"
> | null => {
  const userMessages = extractObservedFeedbackResponses(turns, workUnitStates);
  const explicitSignals = detectExplicitPreferenceSignals(userMessages);
  const interventionFocus = decideInterventionFocusHeuristically(
    insights,
    explicitSignals.relationshipFocusSignal,
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

export const learnPreferredExecutionModeHeuristically = (
  turns: TurnRecord[],
  workUnitStates: RelationshipWorkUnitState[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipExecutionModePreference | null => {
  const userMessages = extractObservedFeedbackResponses(turns, workUnitStates);
  const explicitSignals = detectExplicitPreferenceSignals(userMessages);
  if (explicitSignals.preferredExecutionMode) {
    return explicitSignals.preferredExecutionMode;
  }
  return currentPolicyState?.preferredExecutionMode ?? null;
};

const decideInterventionFocusHeuristically = (
  insights: RelationshipMemoryInsights,
  relationshipFocusSignal: boolean,
  currentPolicyState: RelationshipInterventionPolicyState | null,
): RelationshipInterventionFocus => {
  if (relationshipFocusSignal) {
    return "relationship";
  }
  if (
    insights.report.repairCandidates.length > 0 ||
    insights.report.boundaryCandidates.length > 0 ||
    insights.report.proactiveContextCandidates.length > 0
  ) {
    return "memory";
  }
  return currentPolicyState?.interventionFocus ?? "balanced";
};
