import assert from "node:assert/strict";
import { createMemorySystemRelationshipMemoryProvider } from "../src/relationship_system/adapters/memorySystemProvider";

const run = async (): Promise<void> => {
  await testMemorySystemAdapterMapsReport();
};

const testMemorySystemAdapterMapsReport = async (): Promise<void> => {
  const provider = createMemorySystemRelationshipMemoryProvider({
    generateMemoryReport: async () => ({
      botId: "ao",
      threadId: "thread-1",
      gaps: ["gap-1"],
      staleNotes: ["stale-1"],
      conflicts: ["conflict-1"],
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
    gaps: ["gap-1"],
    staleNotes: ["stale-1"],
    conflicts: ["conflict-1"],
    createdAtIso: "2026-05-29T00:00:00.000Z",
  });
  assert.match(result.recentContextSummary ?? "", /prefer concise follow-ups/);
};

void run();
