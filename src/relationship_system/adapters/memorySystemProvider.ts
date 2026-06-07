import {
  RelationshipMemoryInsights,
  RelationshipMemoryProvider,
} from "../domain/types";

export interface MemorySystemLike {
  generateRelationshipInsightReport(
    botId: string,
    threadId: string,
  ): Promise<{
    botId: string;
    threadId: string;
    clarificationCandidates: string[];
    proactiveContextCandidates: string[];
    repairCandidates: string[];
    boundaryCandidates: string[];
    createdAtIso: string;
  }>;
  getRecentConversationContext?(input: {
    botId: string;
    threadId: string;
    limit?: number;
    maxTokens?: number;
  }): Promise<string>;
}

export const createMemorySystemRelationshipMemoryProvider = (
  memorySystem: MemorySystemLike,
): RelationshipMemoryProvider => ({
  async getInsights(input): Promise<RelationshipMemoryInsights> {
    const report = await memorySystem.generateRelationshipInsightReport(
      input.botId,
      input.threadId,
    );
    return {
      botId: input.botId,
      threadId: input.threadId,
      ...(memorySystem.getRecentConversationContext
        ? {
            recentContextSummary:
              await memorySystem.getRecentConversationContext({
                botId: input.botId,
                threadId: input.threadId,
              }),
          }
        : {}),
      report: {
        clarificationCandidates: report.clarificationCandidates,
        proactiveContextCandidates: report.proactiveContextCandidates,
        repairCandidates: report.repairCandidates,
        boundaryCandidates: report.boundaryCandidates,
        createdAtIso: report.createdAtIso,
      },
    };
  },
});
