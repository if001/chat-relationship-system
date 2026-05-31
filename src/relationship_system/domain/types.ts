export interface RelationshipMemoryReport {
  gaps: string[];
  staleNotes: string[];
  conflicts: string[];
  createdAtIso: string;
}

export interface RelationshipMemoryInsights {
  botId: string;
  threadId: string;
  report: RelationshipMemoryReport;
  recentContextSummary?: string;
}

export interface TurnMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestampIso: string;
}

export interface TurnRecord {
  id?: string;
  botId: string;
  threadId: string;
  messages: TurnMessage[];
  createdAtIso: string;
}

export type RelationshipTaskKind =
  | "feedback_prepare"
  | "info_gathering"
  | "context_hint"
  | "memory_improvement";

export type RelationshipPriority = "low" | "medium" | "high";
export type RelationshipExecutionMode =
  | "ask_user"
  | "collect_info"
  | "provide_info";
export type RelationshipExecutionModePreference =
  | "balanced"
  | "ask_user"
  | "collect_info"
  | "provide_info";

export interface RelationshipTask {
  id: string;
  unitId: string;
  unitStep: "organize" | "intervene" | "observe" | "adjust";
  botId: string;
  threadId: string;
  kind: RelationshipTaskKind;
  executionMode: RelationshipExecutionMode;
  title: string;
  purpose: string;
  inputText: string;
  priority: RelationshipPriority;
  sourceSignals: string[];
  createdAtIso: string;
}

export interface BackgroundInput {
  botId: string;
  threadId: string;
  text: string;
  sourceTaskId: string;
  sourceUnitId?: string;
  sourceUnitStep?: "organize" | "intervene" | "observe" | "adjust";
}

export interface RelationshipPolicy {
  proactiveHelpLevel: RelationshipPriority;
  askForFeedbackSparingly: boolean;
  maxBackgroundInputsPerRun: number;
}

export interface RelationshipMemoryProvider {
  getInsights(input: {
    botId: string;
    threadId: string;
  }): Promise<RelationshipMemoryInsights>;
}

export interface RelationshipTurnRecordStore {
  appendTurnRecord(turn: TurnRecord): Promise<void>;
  listRecentTurnRecords(input: {
    botId: string;
    threadId: string;
    limit: number;
  }): Promise<TurnRecord[]>;
}

export interface BackgroundInputSink {
  enqueue(input: BackgroundInput): Promise<void>;
}

export interface RelationshipPlanningModel {
  generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

export type ProactiveInfoPreference = "unknown" | "allow" | "avoid";
export type RelationshipInterventionFocus =
  | "balanced"
  | "relationship"
  | "memory";

export interface RelationshipInterventionPolicyState {
  botId: string;
  threadId: string;
  summary: string;
  interventionFocus: RelationshipInterventionFocus;
  preferredExecutionMode: RelationshipExecutionModePreference;
  avoidFeedbackQuestions: boolean;
  preferConcisePrompts: boolean;
  proactiveInfoPreference: ProactiveInfoPreference;
  updatedAtIso: string;
}

export interface RelationshipPolicyStateStore {
  getPolicyState(input: {
    botId: string;
    threadId: string;
  }): Promise<RelationshipInterventionPolicyState | null>;
  savePolicyState(state: RelationshipInterventionPolicyState): Promise<void>;
}
