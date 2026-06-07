import {
  RelationshipExecutionModePreference,
  RelationshipInterventionPolicyState,
  RelationshipMemoryInsights,
  RelationshipPlanningModel,
  RelationshipTask,
  RelationshipWorkUnitState,
  TurnRecord,
} from "../domain/types";
import {
  detectExplicitPreferenceSignals,
  extractObservedFeedbackResponses,
} from "./observeAdjust";
import {
  learnInterventionPolicyStateHeuristically,
  learnPreferredExecutionModeHeuristically,
} from "./heuristicPolicyLearning";
import {
  learnInterventionPolicyStateWithLlm,
  learnPreferredExecutionModeWithLlm,
} from "./llmPolicyLearning";
import {
  sortTasksByPolicyState,
  stabilizeInterventionPolicyState,
} from "./policyStabilizer";

export const learnInterventionPolicyState = async (input: {
  botId: string;
  threadId: string;
  now: Date;
  minPolicyFlipIntervalMs: number;
  insights: RelationshipMemoryInsights;
  recentTurns: TurnRecord[];
  executionModeLearningTurns: TurnRecord[];
  workUnitStates: RelationshipWorkUnitState[];
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
        {
          hasMemoryPressure:
            input.insights.report.repairCandidates.length > 0 ||
            input.insights.report.boundaryCandidates.length > 0 ||
            input.insights.report.proactiveContextCandidates.length > 0,
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
    input.workUnitStates,
    input.currentPolicyState,
  );
  const heuristicPreferredExecutionMode = learnPreferredExecutionModeHeuristically(
    input.executionModeLearningTurns,
    input.workUnitStates,
    input.currentPolicyState,
  );
  if (!heuristic && !heuristicPreferredExecutionMode) {
    return input.currentPolicyState;
  }
  const stabilized = stabilizeInterventionPolicyState(
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
    {
      hasMemoryPressure:
        input.insights.report.repairCandidates.length > 0 ||
        input.insights.report.boundaryCandidates.length > 0 ||
        input.insights.report.proactiveContextCandidates.length > 0,
      explicitSignals: detectExplicitPreferenceSignals(
        extractObservedFeedbackResponses(input.recentTurns, input.workUnitStates),
      ),
    },
  );
  return {
    botId: input.botId,
    threadId: input.threadId,
    updatedAtIso: input.now.toISOString(),
    ...stabilized,
  };
};

export const applyInterventionPolicyState = (
  tasks: RelationshipTask[],
  policyState: RelationshipInterventionPolicyState | null,
): RelationshipTask[] => {
  if (!policyState) {
    return tasks;
  }
  const filtered = tasks
    .filter((task) => {
      if (policyState.avoidFeedbackQuestions && task.unitStep === "observe") {
        return false;
      }
      if (
        policyState.proactiveInfoPreference === "avoid" &&
        task.unitStep === "intervene" &&
        task.executionMode === "provide_info"
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
