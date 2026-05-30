import { createRelationshipBackgroundRunner } from "./backgroundRunner";
import {
  createRelationshipSystemService,
  RelationshipSystemOptions,
} from "./service";

export interface RelationshipBackgroundAppOptions
  extends RelationshipSystemOptions {
  botId: string;
  threadIds: string[];
  pollMs?: number;
  shouldRun?: () => Promise<boolean>;
}

export const createRelationshipBackgroundApp = (
  options: RelationshipBackgroundAppOptions,
) => {
  const service = createRelationshipSystemService(options);
  const runner = createRelationshipBackgroundRunner(service, {
    botId: options.botId,
    threadIds: options.threadIds,
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.shouldRun ? { shouldRun: options.shouldRun } : {}),
  });

  return {
    service,
    runner,
  };
};
