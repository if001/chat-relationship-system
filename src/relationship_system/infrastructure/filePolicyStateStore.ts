import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RelationshipInterventionPolicyState,
  RelationshipPolicyStateStore,
} from "../domain/types";

interface BotPolicyStateFile {
  threads: Record<string, RelationshipInterventionPolicyState>;
}

export const createFileRelationshipPolicyStateStore = (options: {
  baseDir: string;
}): RelationshipPolicyStateStore => {
  const filePathForBot = (botId: string): string =>
    join(options.baseDir, "policies", `${sanitize(botId)}.json`);

  const readBotFile = async (botId: string): Promise<BotPolicyStateFile> => {
    const path = filePathForBot(botId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as BotPolicyStateFile;
      if (!parsed || typeof parsed !== "object" || !parsed.threads) {
        return { threads: {} };
      }
      return parsed;
    } catch {
      return { threads: {} };
    }
  };

  const writeBotFile = async (
    botId: string,
    data: BotPolicyStateFile,
  ): Promise<void> => {
    const path = filePathForBot(botId);
    await mkdir(join(options.baseDir, "policies"), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    async getPolicyState(input) {
      const data = await readBotFile(input.botId);
      return data.threads[input.threadId] ?? null;
    },
    async savePolicyState(state) {
      const data = await readBotFile(state.botId);
      data.threads[state.threadId] = state;
      await writeBotFile(state.botId, data);
    },
  };
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
