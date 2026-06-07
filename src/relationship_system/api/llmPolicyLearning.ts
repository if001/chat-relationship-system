import {
  ProactiveInfoPreference,
  RelationshipExecutionModePreference,
  RelationshipInterventionPolicyState,
  RelationshipMemoryInsights,
  RelationshipPlanningModel,
  TurnRecord,
} from "../domain/types";
import {
  normalizeExecutionModePreference,
  normalizeInterventionFocus,
  normalizeProactiveInfoPreference,
} from "./policyStabilizer";
import { detectExplicitPreferenceSignals } from "./observeAdjust";

export interface LearnedPolicyStateResult {
  summary?: string;
  interventionFocus?: string;
  preferredExecutionMode?: string;
  avoidFeedbackQuestions?: boolean;
  preferConcisePrompts?: boolean;
  proactiveInfoPreference?: ProactiveInfoPreference | string;
}

export const learnInterventionPolicyStateWithLlm = async (
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
  const hasMemorySignals =
    insights.report.clarificationCandidates.length > 0 ||
    insights.report.proactiveContextCandidates.length > 0 ||
    insights.report.repairCandidates.length > 0 ||
    insights.report.boundaryCandidates.length > 0;
  const explicitSignals = detectExplicitPreferenceSignals(
    extractUserMessages(turns),
  );
  if (!hasMemorySignals && !explicitSignals.relationshipFocusSignal) {
    return null;
  }
  if (!hasMemorySignals && explicitSignals.relationshipFocusSignal) {
    const summaryParts = [
      explicitSignals.avoidFeedbackQuestions === true
        ? "The user prefers fewer feedback questions."
        : explicitSignals.avoidFeedbackQuestions === false
          ? "The user appears open to occasional feedback questions."
          : "",
      explicitSignals.preferConcisePrompts === true
        ? "The user prefers concise prompts."
        : explicitSignals.preferConcisePrompts === false
          ? "The user appears comfortable with more detailed prompts."
          : "",
      explicitSignals.proactiveInfoPreference === "avoid"
        ? "Avoid proactive information unless clearly useful."
        : explicitSignals.proactiveInfoPreference === "allow"
          ? "Proactive information is welcome when useful."
          : "",
    ].filter(Boolean);
    return {
      summary:
        summaryParts.join(" ") ||
        currentPolicyState?.summary ||
        "Prefer relationship-improvement interventions first.",
      interventionFocus: "relationship",
      preferredExecutionMode:
        explicitSignals.preferredExecutionMode ??
        currentPolicyState?.preferredExecutionMode ??
        "balanced",
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
  }
  const policyInput = currentPolicyState
    ? {
        summary: currentPolicyState.summary,
        interventionFocus: currentPolicyState.interventionFocus,
        preferredExecutionMode: currentPolicyState.preferredExecutionMode,
        avoidFeedbackQuestions: currentPolicyState.avoidFeedbackQuestions,
        preferConcisePrompts: currentPolicyState.preferConcisePrompts,
        proactiveInfoPreference: currentPolicyState.proactiveInfoPreference,
      }
    : null;
  const parsed = await plannerModel.generateJson<LearnedPolicyStateResult>(
    [
      "あなたは assistant 用の軽量な介入ポリシーを更新します。",
      "relationshipInsightReport は relationship-support の機会を要約したものです:",
      "- clarificationCandidates: 明確化する価値があるユーザーの好みや制約。",
      "- proactiveContextCandidates: 先回りして短く共有する価値がある有用な文脈。",
      "- repairCandidates: 修復したほうがよい矛盾、摩擦、不一致。",
      "- boundaryCandidates: 明確化したほうがよい区別やスコープ境界。",
      "currentPolicyState は、存在する場合の現在の軽量ポリシー snapshot です。",
      "recentTurns は、どの対話スタイルが現在うまく機能しているかを判断するための直近の assistant と user のメッセージです。",
      "interventionFocus は厳密に relationship, memory, balanced から選んでください。",
      "preferredExecutionMode は厳密に ask_user, collect_info, provide_info, balanced から選んでください。",
      "proactiveInfoPreference は厳密に allow, avoid, unknown から選んでください。",
      "また、feedback question を減らすべきか、prompt を簡潔に保つべきかも判断してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "relationshipInsightReport, currentPolicyState, recentTurns を読んでください。",
        "次の relationship-support intervention を導くポリシーを要約してください。",
        "次の field を厳密に返してください:",
        "- summary: short natural-language policy summary",
        "- interventionFocus: relationship | memory | balanced",
        "- preferredExecutionMode: ask_user | collect_info | provide_info | balanced",
        "- avoidFeedbackQuestions: boolean",
        "- preferConcisePrompts: boolean",
        "- proactiveInfoPreference: allow | avoid | unknown",
      ].join(" "),
      relationshipInsightReport: {
        clarificationCandidates: insights.report.clarificationCandidates,
        proactiveContextCandidates: insights.report.proactiveContextCandidates,
        repairCandidates: insights.report.repairCandidates,
        boundaryCandidates: insights.report.boundaryCandidates,
      },
      currentPolicyState: policyInput,
      recentTurns: lines,
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

export const learnPreferredExecutionModeWithLlm = async (
  turns: TurnRecord[],
  currentPolicyState: RelationshipInterventionPolicyState | null,
  plannerModel: RelationshipPlanningModel,
): Promise<RelationshipExecutionModePreference | null> => {
  const lines = formatRecentTurns(turns, 16);
  if (lines.length === 0) {
    return null;
  }
  const explicitSignals = detectExplicitPreferenceSignals(
    extractUserMessages(turns),
  );
  if (explicitSignals.preferredExecutionMode) {
    return explicitSignals.preferredExecutionMode;
  }
  if (extractUserMessages(turns).length === 0) {
    return currentPolicyState?.preferredExecutionMode ?? null;
  }
  const policyInput = currentPolicyState
    ? {
        summary: currentPolicyState.summary,
        interventionFocus: currentPolicyState.interventionFocus,
        preferredExecutionMode: currentPolicyState.preferredExecutionMode,
        avoidFeedbackQuestions: currentPolicyState.avoidFeedbackQuestions,
        preferConcisePrompts: currentPolicyState.preferConcisePrompts,
        proactiveInfoPreference: currentPolicyState.proactiveInfoPreference,
      }
    : null;
  const parsed = await plannerModel.generateJson<{
    preferredExecutionMode?: RelationshipExecutionModePreference | string;
  }>(
    [
      "あなたは relationship-support task に対して、現在もっとも有効そうな execution mode を推定します。",
      "currentPolicyState は、存在する場合の現在の軽量ポリシー snapshot です。",
      "recentTurns は、どの対話スタイルが機能しているかを判断するための直近の assistant と user のメッセージです。",
      "preferredExecutionMode は厳密に ask_user, collect_info, provide_info, balanced から選んでください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "currentPolicyState と recentTurns を読んでください。",
        "この少し長めのスパンで、どの execution mode がもっとも有効に見えるかを推定してください。",
        "厳密に { preferredExecutionMode: ask_user | collect_info | provide_info | balanced } を返してください。",
      ].join(" "),
      currentPolicyState: policyInput,
      recentTurns: lines,
    }),
  );
  if (parsed.preferredExecutionMode === undefined) {
    return null;
  }
  return normalizeExecutionModePreference(parsed.preferredExecutionMode);
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

const extractUserMessages = (turns: TurnRecord[]): string[] =>
  turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
