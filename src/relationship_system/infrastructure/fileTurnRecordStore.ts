import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RelationshipTurnRecordStore, TurnRecord } from "../domain/types";

interface BotTurnRecordFile {
  threads: Record<string, TurnRecord[]>;
}

export interface FileRelationshipTurnRecordStoreOptions {
  baseDir: string;
  maxTurnsPerThread?: number;
}

export const createFileRelationshipTurnRecordStore = (
  options: FileRelationshipTurnRecordStoreOptions,
): RelationshipTurnRecordStore => {
  const maxTurnsPerThread = Math.max(1, options.maxTurnsPerThread ?? 200);

  const loadBotFile = async (botId: string): Promise<BotTurnRecordFile> => {
    const path = toFilePath(options.baseDir, botId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as BotTurnRecordFile;
      if (!parsed || typeof parsed !== "object" || !parsed.threads) {
        return { threads: {} };
      }
      return parsed;
    } catch {
      return { threads: {} };
    }
  };

  const saveBotFile = async (
    botId: string,
    data: BotTurnRecordFile,
  ): Promise<void> => {
    const path = toFilePath(options.baseDir, botId);
    await mkdir(options.baseDir, { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    async appendTurnRecord(turn: TurnRecord): Promise<void> {
      const data = await loadBotFile(turn.botId);
      const items = data.threads[turn.threadId] ?? [];
      const next = withStableId(turn, items.length);
      items.push(next);
      data.threads[turn.threadId] = items.slice(-maxTurnsPerThread);
      await saveBotFile(turn.botId, data);
    },
    async listRecentTurnRecords(input): Promise<TurnRecord[]> {
      const data = await loadBotFile(input.botId);
      const items = data.threads[input.threadId] ?? [];
      return items.slice(-Math.max(1, input.limit));
    },
  };
};

const toFilePath = (baseDir: string, botId: string): string =>
  join(baseDir, `${sanitize(botId)}.json`);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

const withStableId = (turn: TurnRecord, indexHint: number): TurnRecord => {
  if (turn.id) {
    return turn;
  }
  return {
    ...turn,
    id: `rel_turn_${sanitize(turn.threadId)}_${turn.createdAtIso}_${indexHint}`,
  };
};
