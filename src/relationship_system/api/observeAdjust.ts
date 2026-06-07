import {
  RelationshipPlanningModel,
  RelationshipWorkUnitState,
  TurnRecord,
} from "../domain/types";

export interface ExplicitPreferenceSignals {
  avoidFeedbackQuestions?: boolean;
  preferConcisePrompts?: boolean;
  proactiveInfoPreference?: "unknown" | "allow" | "avoid";
  relationshipFocusSignal: boolean;
  preferredExecutionMode?: "balanced" | "ask_user" | "collect_info" | "provide_info";
}

export const detectExplicitPreferenceSignals = (
  userMessages: string[],
): ExplicitPreferenceSignals => {
  const joined = userMessages.join("\n");
  const avoidFeedbackQuestions =
    /(too many|多すぎ|減ら|うるさい|no more questions|no response to feedback frequency question)/i.test(joined)
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

export const extractObservedFeedbackResponses = (
  turns: TurnRecord[],
  workUnitStates: RelationshipWorkUnitState[] = [],
): string[] => {
  const directWorkUnitResponses = workUnitStates
    .filter(
      (unit) =>
        unit.currentStep === "adjust" &&
        unit.status === "response_received" &&
        unit.observedResponseText,
    )
    .map((unit) => unit.observedResponseText?.trim() ?? "")
    .filter(Boolean);
  if (directWorkUnitResponses.length > 0) {
    return directWorkUnitResponses;
  }
  const recentNoSignalFeedbackUnit = workUnitStates.some(
    (unit) => unit.currentStep === "adjust" && unit.status === "no_signal",
  );
  if (recentNoSignalFeedbackUnit) {
    return ["no response to feedback frequency question"];
  }
  const messages = turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user" || message.role === "assistant");
  const observedResponses: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    if (!isFeedbackProbeMessage(message.content)) {
      continue;
    }
    for (
      let lookahead = index + 1;
      lookahead < messages.length && lookahead <= index + 3;
      lookahead += 1
    ) {
      const response = messages[lookahead];
      if (!response) {
        continue;
      }
      if (response.role === "assistant") {
        break;
      }
      const text = response.content.trim();
      if (text) {
        observedResponses.push(text);
      }
    }
  }
  if (observedResponses.length > 0) {
    return observedResponses;
  }
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
};

export const observeFeedbackResponse = async (
  turns: TurnRecord[],
  unit: RelationshipWorkUnitState,
  plannerModel?: RelationshipPlanningModel,
): Promise<
  | { kind: "pending" }
  | { kind: "response_received"; responseText: string }
  | { kind: "no_signal" }
> => {
  const interventionAt = Date.parse(unit.lastInterventionAtIso ?? "");
  if (!Number.isFinite(interventionAt)) {
    return { kind: "pending" };
  }
  const responseWindowTurns = unit.responseWindowTurns ?? 3;
  const subsequentTurns = turns.filter(
    (turn) => Date.parse(turn.createdAtIso) > interventionAt,
  );
  for (const turn of subsequentTurns.slice(0, responseWindowTurns)) {
    for (const message of turn.messages) {
      if (message.role !== "user") {
        continue;
      }
      const text = message.content.trim();
      if (!text) {
        continue;
      }
      if (isLikelyObservationResponse(text)) {
        return { kind: "response_received", responseText: text };
      }
      if (!plannerModel || !(unit.lastObservationPrompt?.trim())) {
        continue;
      }
      const matches = plannerModel
        ? await classifyObservedFeedbackReplyWithLlm(
            unit.lastObservationPrompt,
            text,
            plannerModel,
          )
        : false;
      if (matches) {
        return { kind: "response_received", responseText: text };
      }
    }
  }
  if (subsequentTurns.length >= responseWindowTurns) {
    return { kind: "no_signal" };
  }
  return { kind: "pending" };
};

const classifyObservedFeedbackReplyWithLlm = async (
  observationPrompt: string,
  userReply: string,
  plannerModel: RelationshipPlanningModel,
): Promise<boolean> => {
  const parsed = await plannerModel.generateJson<{ isFeedbackResponse?: boolean }>(
    [
      "あなたは user reply が、以前の assistant の feedback question に答えているかを判定します。",
      "observationPrompt は、介入の頻度、量、スタイル、有用性について assistant が以前に行った質問です。",
      "userReply は、その質問に答えているかもしれない後続の user message です。",
      "userReply が observationPrompt に実際に答えている場合だけ true を返してください。",
      "userReply が別の話題を始めている、または介入へのコメントになっていない場合は false を返してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "observationPrompt と userReply を読んでください。",
        "userReply が observationPrompt の feedback question に対する応答かどうかを判定してください。",
        "厳密に { isFeedbackResponse: boolean } を返してください。",
      ].join(" "),
      observationPrompt,
      userReply,
    }),
  );
  return parsed.isFeedbackResponse === true;
};

const isFeedbackProbeMessage = (content: string): boolean =>
  /(頻度|多すぎ|減ら|補足|確認).*教えて|feedback|too frequent|too many questions|reduce|確認頻度/i.test(
    content,
  );

const isLikelyObservationResponse = (content: string): boolean =>
  /(多い|少ない|減ら|増や|このままで|ちょうど|大丈夫|十分|不要|keep|fine|good|too much|too many|less|more|brief|short)/i.test(
    content,
  );
