import {
  createFileQueueBackgroundInputSink,
  createFileRelationshipPolicyStateStore,
  createFileRelationshipTurnRecordStore,
  createMemorySystemRelationshipMemoryProvider,
  createOllamaRelationshipPlanningModel,
  createRelationshipBackgroundApp,
  getFileQueueStatus,
} from "../index";

interface MemorySystemServiceLike {
  generateMemoryReport(botId: string, threadId: string): Promise<{
    botId: string;
    threadId: string;
    gaps: string[];
    staleNotes: string[];
    conflicts: string[];
    createdAtIso: string;
  }>;
  getRecentConversationContext?(input: {
    botId: string;
    threadId: string;
    limit?: number;
    maxTokens?: number;
  }): Promise<string>;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const optionalNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const botId = process.env.BOT_ID ?? "ao";
  const pollMs = optionalNumber("RELATIONSHIP_BACKGROUND_POLL_MS", 60_000);
  const threadIds = (process.env.RELATIONSHIP_THREAD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (threadIds.length === 0) {
    process.stdout.write(
      "[relationship-system] RELATIONSHIP_THREAD_IDS is empty; exiting without starting runner\n",
    );
    return;
  }

  const memoryModule = require("@chat-agent/memory-system") as {
    createMemorySystemService?: (params: {
      postgresUrl: string;
      ollamaBaseUrl: string;
      ollamaModel: string;
    }) => MemorySystemServiceLike;
  };
  if (!memoryModule.createMemorySystemService) {
    throw new Error(
      "createMemorySystemService not found. Install @chat-agent/memory-system for relationship background runtime.",
    );
  }

  const memoryService = memoryModule.createMemorySystemService({
    postgresUrl: required("POSTGRES_URL"),
    ollamaBaseUrl: required("OLLAMA_BASE_URL"),
    ollamaModel: required("OLLAMA_CHAT_MODEL"),
  });

  const queueFilePath = required("RELATIONSHIP_QUEUE_FILE");
  const backgroundApp = createRelationshipBackgroundApp({
    botId,
    threadIds,
    pollMs,
    turnRecordStore: createFileRelationshipTurnRecordStore({
      baseDir: process.env.RELATIONSHIP_STORE_DIR ?? "data/relationship-system",
      maxTurnsPerThread: optionalNumber(
        "RELATIONSHIP_MAX_TURNS_PER_THREAD",
        200,
      ),
    }),
    recentTurnLimit: optionalNumber("RELATIONSHIP_RECENT_TURN_LIMIT", 4),
    policyLearningTurnLimit: optionalNumber(
      "RELATIONSHIP_POLICY_LEARNING_TURN_LIMIT",
      8,
    ),
    executionModeLearningTurnLimit: optionalNumber(
      "RELATIONSHIP_EXECUTION_MODE_LEARNING_TURN_LIMIT",
      16,
    ),
    policyStateStore: createFileRelationshipPolicyStateStore({
      baseDir: process.env.RELATIONSHIP_STORE_DIR ?? "data/relationship-system",
    }),
    memoryProvider: createMemorySystemRelationshipMemoryProvider(memoryService),
    backgroundInputSink: createFileQueueBackgroundInputSink({
      filePath: queueFilePath,
      channelId:
        process.env.RELATIONSHIP_CHANNEL_ID ?? required("MENTION_CHANNEL_ID"),
      enqueueCooldownMs: optionalNumber(
        "RELATIONSHIP_ENQUEUE_COOLDOWN_MS",
        3_600_000,
      ),
    }),
    plannerModel: createOllamaRelationshipPlanningModel(
      required("OLLAMA_BASE_URL"),
      required("OLLAMA_CHAT_MODEL"),
      process.env.OLLAMA_API_KEY,
    ),
    shouldRun: async () => {
      const status = await getFileQueueStatus(queueFilePath);
      const busy =
        status.counts.locked > 0 || status.counts.readyByType.user > 0;
      if (busy) {
        process.stdout.write(
          `[relationship-system] skipped background dispatch because user queue is busy locked=${status.counts.locked} readyUser=${status.counts.readyByType.user}\n`,
        );
      }
      return !busy;
    },
  });

  process.stdout.write(
    `[relationship-system] starting botId=${botId} threads=${threadIds.join(",")} pollMs=${pollMs}\n`,
  );
  backgroundApp.runner.start();

  const shutdown = (): void => {
    process.stdout.write("[relationship-system] stopping\n");
    backgroundApp.runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stdout.write(`${message}\n`);
  process.exit(1);
});
