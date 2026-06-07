import assert from "node:assert/strict";
import { test } from "vitest";
import { createMemorySystemRelationshipMemoryProvider } from "../src/relationship_system/adapters/memorySystemProvider";

const testMemorySystemAdapterMapsReport = async (): Promise<void> => {
  const provider = createMemorySystemRelationshipMemoryProvider({
    generateRelationshipInsightReport: async () => ({
      botId: "ao",
      threadId: "thread-1",
      clarificationCandidates: ["gap-1"],
      proactiveContextCandidates: ["stale-1"],
      repairCandidates: ["conflict-1"],
      boundaryCandidates: ["boundary-1"],
      createdAtIso: "2026-05-29T00:00:00.000Z",
    }),
    getRecentConversationContext: async () =>
      "Recent conversation history:\nRecent turn 1\n[user] prefer concise follow-ups",
  });

  const result = await provider.getInsights({
    botId: "ao",
    threadId: "thread-1",
  });

  assert.deepEqual(result.report, {
    clarificationCandidates: ["gap-1"],
    proactiveContextCandidates: ["stale-1"],
    repairCandidates: ["conflict-1"],
    boundaryCandidates: ["boundary-1"],
    createdAtIso: "2026-05-29T00:00:00.000Z",
  });
  assert.match(result.recentContextSummary ?? "", /prefer concise follow-ups/);
};

test("memory-system adapter maps report", testMemorySystemAdapterMapsReport);
