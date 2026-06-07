import {
  createFileQueueBackgroundInputSink,
  createFileRelationshipPolicyStateStore,
  createFileRelationshipTurnRecordStore,
  createFileRelationshipWorkUnitStateStore,
  createFileCachedRelationshipPlanningModel,
  createMemorySystemRelationshipMemoryProvider,
  createOllamaRelationshipPlanningModel,
  createRelationshipBackgroundApp,
  getFileQueueStatus,
} from "../index";
import { join } from "node:path";

interface MemorySystemServiceLike {
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

export interface RunBackgroundDependencies {
  loadMemoryModule: () => {
    createMemorySystemService?: (params: {
      postgresUrl: string;
      ollamaBaseUrl: string;
      ollamaModel: string;
      ollamaAPIKey: string;
    }) => MemorySystemServiceLike;
  };
}

const defaultDependencies: RunBackgroundDependencies = {
  loadMemoryModule: () =>
    require("@chat-agent/memory-system") as {
      createMemorySystemService?: (params: {
        postgresUrl: string;
        ollamaBaseUrl: string;
        ollamaModel: string;
        ollamaAPIKey: string;
      }) => MemorySystemServiceLike;
    },
};

const optionalUserScopeMissingMode = (
  name: string,
  env: NodeJS.ProcessEnv,
): "fallback_thread" | "skip_user_scope" => {
  const raw = env[name];
  if (raw === "skip_user_scope") {
    return raw;
  }
  return "fallback_thread";
};

const optionalPolicyScopeMode = (
  name: string,
  env: NodeJS.ProcessEnv,
): "thread" | "user" | "hybrid" => {
  const raw = env[name];
  if (raw === "user" || raw === "hybrid") {
    return raw;
  }
  return "thread";
};

export const buildRelationshipBackgroundAppFromEnv = (
  env: NodeJS.ProcessEnv,
  dependencies: RunBackgroundDependencies = defaultDependencies,
) => {
  const botId = env.BOT_ID ?? "ao";
  const pollMs = optionalNumberFromEnv(
    env,
    "RELATIONSHIP_BACKGROUND_POLL_MS",
    60_000,
  );
  const threadIds = (env.RELATIONSHIP_THREAD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (threadIds.length === 0) {
    return { kind: "empty" as const };
  }

  const memoryModule = dependencies.loadMemoryModule();
  if (!memoryModule.createMemorySystemService) {
    throw new Error(
      "createMemorySystemService not found. Install @chat-agent/memory-system for relationship background runtime.",
    );
  }

  const memoryService = memoryModule.createMemorySystemService({
    postgresUrl: requiredFromEnv(env, "POSTGRES_URL"),
    ollamaBaseUrl: requiredFromEnv(env, "OLLAMA_BASE_URL"),
    ollamaModel: requiredFromEnv(env, "OLLAMA_CHAT_MODEL"),
    ollamaAPIKey: requiredFromEnv(env, "OLLAMA_API_KEY"),
  });

  const queueFilePath = requiredFromEnv(env, "RELATIONSHIP_QUEUE_FILE");
  const storeDir = env.RELATIONSHIP_STORE_DIR ?? "data/relationship-system";
  const policyScopeMode = optionalPolicyScopeMode(
    "RELATIONSHIP_POLICY_SCOPE_MODE",
    env,
  );
  const userScopeMissingUserIdMode = optionalUserScopeMissingMode(
    "RELATIONSHIP_USER_SCOPE_MISSING_USER_ID_MODE",
    env,
  );
  const backgroundApp = createRelationshipBackgroundApp({
    botId,
    threadIds,
    pollMs,
    turnRecordStore: createFileRelationshipTurnRecordStore({
      baseDir: storeDir,
      maxTurnsPerThread: optionalNumberFromEnv(
        env,
        "RELATIONSHIP_MAX_TURNS_PER_THREAD",
        200,
      ),
    }),
    recentTurnLimit: optionalNumberFromEnv(
      env,
      "RELATIONSHIP_RECENT_TURN_LIMIT",
      4,
    ),
    policyLearningTurnLimit: optionalNumberFromEnv(
      env,
      "RELATIONSHIP_POLICY_LEARNING_TURN_LIMIT",
      8,
    ),
    executionModeLearningTurnLimit: optionalNumberFromEnv(
      env,
      "RELATIONSHIP_EXECUTION_MODE_LEARNING_TURN_LIMIT",
      16,
    ),
    dispatchSuppressionWindowMs: optionalNumberFromEnv(
      env,
      "RELATIONSHIP_DISPATCH_SUPPRESSION_WINDOW_MS",
      2 * 60 * 60 * 1000,
    ),
    minTurnAgeMsBeforeLowPriorityDispatch: optionalNumberFromEnv(
      env,
      "RELATIONSHIP_MIN_TURN_AGE_MS_BEFORE_LOW_PRIORITY_DISPATCH",
      10 * 60 * 1000,
    ),
    policyStateStore: createFileRelationshipPolicyStateStore({
      baseDir: storeDir,
    }),
    workUnitStateStore: createFileRelationshipWorkUnitStateStore({
      baseDir: storeDir,
    }),
    policyScopeMode,
    userScopeMissingUserIdMode,
    memoryProvider: createMemorySystemRelationshipMemoryProvider(memoryService),
    backgroundInputSink: createFileQueueBackgroundInputSink({
      filePath: queueFilePath,
      channelId:
        env.RELATIONSHIP_CHANNEL_ID ??
        requiredFromEnv(env, "MENTION_CHANNEL_ID"),
      enqueueCooldownMs: optionalNumberFromEnv(
        env,
        "RELATIONSHIP_ENQUEUE_COOLDOWN_MS",
        3_600_000,
      ),
      ...(env.RELATIONSHIP_QUEUE_DEBUG_LOG_FILE
        ? {
            debugLogFilePath: env.RELATIONSHIP_QUEUE_DEBUG_LOG_FILE,
          }
        : {}),
    }),
    plannerModel: createFileCachedRelationshipPlanningModel(
      createOllamaRelationshipPlanningModel(
        requiredFromEnv(env, "OLLAMA_BASE_URL"),
        requiredFromEnv(env, "OLLAMA_CHAT_MODEL"),
        env.OLLAMA_API_KEY,
      ),
      {
        cacheDir:
          env.RELATIONSHIP_LLM_CACHE_DIR ?? join(storeDir, "llm-cache"),
        ttlMs: optionalNumberFromEnv(
          env,
          "RELATIONSHIP_LLM_CACHE_TTL_MS",
          24 * 60 * 60 * 1000,
        ),
      },
    ),
    queueStatusProvider: async () => {
      const status = await getFileQueueStatus(queueFilePath);
      return {
        locked: status.counts.locked,
        readyUser: status.counts.readyByType.user,
        readyScheduled:
          status.counts.readyByType.scheduled_once +
          status.counts.readyByType.scheduled_recurring,
      };
    },
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

  return {
    kind: "app" as const,
    app: backgroundApp,
    meta: {
      botId,
      pollMs,
      threadIds,
      policyScopeMode,
      userScopeMissingUserIdMode,
    },
  };
};

const main = async (): Promise<void> => {
  const built = buildRelationshipBackgroundAppFromEnv(process.env);
  if (built.kind === "empty") {
    process.stdout.write(
      "[relationship-system] RELATIONSHIP_THREAD_IDS is empty; exiting without starting runner\n",
    );
    return;
  }
  const { app: backgroundApp, meta } = built;

  process.stdout.write(
    `[relationship-system] starting botId=${meta.botId} threads=${meta.threadIds.join(",")} pollMs=${meta.pollMs} scopeMode=${meta.policyScopeMode} missingUserIdMode=${meta.userScopeMissingUserIdMode}\n`,
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

const requiredFromEnv = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const optionalNumberFromEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return value;
};

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stdout.write(`${message}\n`);
  process.exit(1);
});
