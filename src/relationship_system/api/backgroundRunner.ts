import { RelationshipSystemService } from "./service";

export interface RelationshipBackgroundRunnerOptions {
  botId: string;
  threadIds: string[];
  pollMs?: number;
  shouldRun?: () => Promise<boolean>;
}

export interface RelationshipBackgroundRunner {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
}

export const createRelationshipBackgroundRunner = (
  service: Pick<RelationshipSystemService, "dispatchTasks">,
  options: RelationshipBackgroundRunnerOptions,
): RelationshipBackgroundRunner => {
  const pollMs = options.pollMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    if (options.shouldRun && !(await options.shouldRun())) {
      return;
    }
    for (const threadId of options.threadIds) {
      await service.dispatchTasks({
        botId: options.botId,
        threadId,
      });
    }
  };

  const tick = (): void => {
    if (!running || inFlight) {
      return;
    }
    inFlight = runOnce()
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stdout.write(`[relationship-background-error] ${message}\n`);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      timer = setInterval(tick, pollMs);
      timer.unref?.();
      tick();
    },
    stop(): void {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async runOnce(): Promise<void> {
      await runOnce();
    },
  };
};
