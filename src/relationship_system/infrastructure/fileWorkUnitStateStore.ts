import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RelationshipWorkUnitState,
  RelationshipWorkUnitStateStore,
} from "../domain/types";

interface BotWorkUnitFile {
  threads: Record<string, RelationshipWorkUnitState[]>;
}

export const createFileRelationshipWorkUnitStateStore = (options: {
  baseDir: string;
}): RelationshipWorkUnitStateStore => {
  const filePathForBot = (botId: string): string =>
    join(options.baseDir, "work-units", `${sanitize(botId)}.json`);

  const readBotFile = async (botId: string): Promise<BotWorkUnitFile> => {
    const path = filePathForBot(botId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as BotWorkUnitFile;
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
    data: BotWorkUnitFile,
  ): Promise<void> => {
    const path = filePathForBot(botId);
    await mkdir(join(options.baseDir, "work-units"), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    async listWorkUnits(input) {
      const data = await readBotFile(input.botId);
      return data.threads[input.threadId] ?? [];
    },
    async saveWorkUnit(state) {
      const data = await readBotFile(state.botId);
      const items = data.threads[state.threadId] ?? [];
      const next = items.filter((item) => item.unitId !== state.unitId);
      next.push(state);
      data.threads[state.threadId] = next;
      await writeBotFile(state.botId, data);
    },
  };
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
