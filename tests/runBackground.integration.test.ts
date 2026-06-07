import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import { buildRelationshipBackgroundAppFromEnv } from "../src/cli/runBackground";

test("buildRelationshipBackgroundAppFromEnv returns empty when thread ids are missing", () => {
  const built = buildRelationshipBackgroundAppFromEnv(
    {
      BOT_ID: "ao",
    },
    {
      loadMemoryModule: () => ({
        createMemorySystemService: () => ({
          generateRelationshipInsightReport: async () => ({
            botId: "ao",
            threadId: "thread-1",
            clarificationCandidates: [],
            proactiveContextCandidates: [],
            repairCandidates: [],
            boundaryCandidates: [],
            createdAtIso: "2026-05-29T00:00:00.000Z",
          }),
        }),
      }),
    },
  );
  assert.equal(built.kind, "empty");
});

test("buildRelationshipBackgroundAppFromEnv passes ollama api key to memory service", () => {
  let received:
    | {
        postgresUrl: string;
        ollamaBaseUrl: string;
        ollamaModel: string;
        ollamaAPIKey: string;
      }
    | undefined;

  const built = buildRelationshipBackgroundAppFromEnv(
    {
      BOT_ID: "ao",
      POSTGRES_URL: "postgres://example",
      OLLAMA_BASE_URL: "http://ollama.local",
      OLLAMA_CHAT_MODEL: "qwen3",
      OLLAMA_API_KEY: "secret-key",
      RELATIONSHIP_THREAD_IDS: "thread-1",
      RELATIONSHIP_QUEUE_FILE: "/tmp/queue.json",
      MENTION_CHANNEL_ID: "channel-1",
    },
    {
      loadMemoryModule: () => ({
        createMemorySystemService: (params) => {
          received = params;
          return {
            generateRelationshipInsightReport: async () => ({
              botId: "ao",
              threadId: "thread-1",
              clarificationCandidates: [],
              proactiveContextCandidates: [],
              repairCandidates: [],
              boundaryCandidates: [],
              createdAtIso: "2026-05-29T00:00:00.000Z",
            }),
          };
        },
      }),
    },
  );

  assert.equal(built.kind, "app");
  assert.deepEqual(received, {
    postgresUrl: "postgres://example",
    ollamaBaseUrl: "http://ollama.local",
    ollamaModel: "qwen3",
    ollamaAPIKey: "secret-key",
  });
});

test("buildRelationshipBackgroundAppFromEnv throws when required env is missing", () => {
  assert.throws(
    () =>
      buildRelationshipBackgroundAppFromEnv(
        {
          BOT_ID: "ao",
          RELATIONSHIP_THREAD_IDS: "thread-1",
          OLLAMA_BASE_URL: "http://ollama.local",
          OLLAMA_CHAT_MODEL: "qwen3",
          RELATIONSHIP_QUEUE_FILE: "/tmp/queue.json",
          MENTION_CHANNEL_ID: "channel-1",
        },
        {
          loadMemoryModule: () => ({
            createMemorySystemService: () => ({
              generateRelationshipInsightReport: async () => ({
                botId: "ao",
                threadId: "thread-1",
                clarificationCandidates: [],
                proactiveContextCandidates: [],
                repairCandidates: [],
                boundaryCandidates: [],
                createdAtIso: "2026-05-29T00:00:00.000Z",
              }),
            }),
          }),
        },
      ),
    /Missing environment variable: POSTGRES_URL/,
  );
});

test("buildRelationshipBackgroundAppFromEnv throws when numeric env is invalid", () => {
  assert.throws(
    () =>
      buildRelationshipBackgroundAppFromEnv(
        {
          BOT_ID: "ao",
          POSTGRES_URL: "postgres://example",
          OLLAMA_BASE_URL: "http://ollama.local",
          OLLAMA_CHAT_MODEL: "qwen3",
          RELATIONSHIP_THREAD_IDS: "thread-1",
          RELATIONSHIP_QUEUE_FILE: "/tmp/queue.json",
          MENTION_CHANNEL_ID: "channel-1",
          RELATIONSHIP_BACKGROUND_POLL_MS: "abc",
        },
        {
          loadMemoryModule: () => ({
            createMemorySystemService: () => ({
              generateRelationshipInsightReport: async () => ({
                botId: "ao",
                threadId: "thread-1",
                clarificationCandidates: [],
                proactiveContextCandidates: [],
                repairCandidates: [],
                boundaryCandidates: [],
                createdAtIso: "2026-05-29T00:00:00.000Z",
              }),
            }),
          }),
        },
      ),
    /Invalid numeric environment variable: RELATIONSHIP_BACKGROUND_POLL_MS/,
  );
});

test("buildRelationshipBackgroundAppFromEnv throws when memory factory is unavailable", () => {
  assert.throws(
    () =>
      buildRelationshipBackgroundAppFromEnv(
        {
          BOT_ID: "ao",
          POSTGRES_URL: "postgres://example",
          OLLAMA_BASE_URL: "http://ollama.local",
          OLLAMA_CHAT_MODEL: "qwen3",
          RELATIONSHIP_THREAD_IDS: "thread-1",
          RELATIONSHIP_QUEUE_FILE: "/tmp/queue.json",
          MENTION_CHANNEL_ID: "channel-1",
        },
        {
          loadMemoryModule: () => ({}),
        },
      ),
    /createMemorySystemService not found/,
  );
});

test("buildRelationshipBackgroundAppFromEnv wires queue backlog suppression and runner", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "relationship-run-bg-"));
  const queuePath = join(baseDir, "queue.json");
  await writeFile(
    queuePath,
    JSON.stringify([
      {
        id: "q1",
        type: "user",
        action: "mention",
        text: "hello",
        channelId: "channel-1",
        authorId: "user-1",
        mentionsBot: true,
        dueAt: "2026-05-29T00:00:00.000Z",
        createdAt: "2026-05-29T00:00:00.000Z",
        locked: false,
      },
    ]),
    "utf8",
  );

  const env = {
    BOT_ID: "ao",
    POSTGRES_URL: "postgres://example",
    OLLAMA_BASE_URL: "http://ollama.local",
    OLLAMA_CHAT_MODEL: "qwen3",
    OLLAMA_API_KEY: "secret-key",
    RELATIONSHIP_THREAD_IDS: "thread-1",
    RELATIONSHIP_QUEUE_FILE: queuePath,
    RELATIONSHIP_STORE_DIR: baseDir,
    MENTION_CHANNEL_ID: "channel-1",
  };

  const built = buildRelationshipBackgroundAppFromEnv(env, {
    loadMemoryModule: () => ({
      createMemorySystemService: () => ({
        generateRelationshipInsightReport: async () => ({
          botId: "ao",
          threadId: "thread-1",
          clarificationCandidates: ["Unknown preference."],
          proactiveContextCandidates: [],
          repairCandidates: [],
          boundaryCandidates: [],
          createdAtIso: "2026-05-29T00:00:00.000Z",
        }),
        getRecentConversationContext: async () => "",
      }),
    }),
  });

  assert.equal(built.kind, "app");
  await built.app.runner.runOnce();

  const raw = await readFile(queuePath, "utf8");
  const queue = JSON.parse(raw) as Array<{ action: string }>;
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.action, "mention");
});
