import {
  RelationshipMemoryInsights,
  RelationshipMemoryProvider,
} from "../domain/types";

export interface MemorySystemLike {
  generateMemoryReport(botId: string, threadId: string): Promise<{
    botId: string;
    threadId: string;
    gaps: string[];
    staleNotes: string[];
    conflicts: string[];
    createdAtIso: string;
  }>;
  getRecentConversationContext?(
    input: {
      botId: string;
      threadId: string;
      limit?: number;
      maxTokens?: number;
    },
  ): Promise<string>;
}

export const createMemorySystemRelationshipMemoryProvider = (
  memorySystem: MemorySystemLike,
): RelationshipMemoryProvider => ({
  async getInsights(input): Promise<RelationshipMemoryInsights> {
    const report = await memorySystem.generateMemoryReport(
      input.botId,
      input.threadId,
    );
    return {
      botId: input.botId,
      threadId: input.threadId,
      ...(memorySystem.getRecentConversationContext
        ? {
            recentContextSummary: await memorySystem.getRecentConversationContext({
              botId: input.botId,
              threadId: input.threadId,
            }),
          }
        : {}),
      report: {
        gaps: report.gaps,
        staleNotes: report.staleNotes,
        conflicts: report.conflicts,
        createdAtIso: report.createdAtIso,
      },
    };
  },
});
