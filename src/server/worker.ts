import type { TaskStatus } from "../shared/types.js";
import { AppDatabase } from "./database.js";
import { renderTask, RenderError } from "./renderer.js";
import { UnsafeUrlError } from "./security.js";
import { BrowserUnavailableError } from "./browser.js";

export class RenderWorker {
  private running = false;
  private wakeResolver: (() => void) | null = null;

  constructor(private readonly database: AppDatabase) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.wake();
  }

  wake(): void {
    this.wakeResolver?.();
    this.wakeResolver = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const task = this.database.getNextQueuedTask();
      if (!task) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.wakeResolver = null;
            resolve();
          }, 1500);
          this.wakeResolver = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        continue;
      }

      try {
        const result = await renderTask(task, this.database.getSettings(), {
          onStatus: (status: TaskStatus) => this.database.updateStatus(task.id, status),
          onInspection: (inspection) => this.database.updateInspection(task.id, inspection)
        });
        if (result.kind === "needs_review") {
          this.database.markNeedsReview(task.id, result.message);
        } else {
          this.database.completeTask(task.id, result.outputPath, result.filename);
        }
      } catch (error) {
        const code =
          error instanceof RenderError || error instanceof UnsafeUrlError || error instanceof BrowserUnavailableError
            ? error.code
            : "UNEXPECTED_ERROR";
        const message = error instanceof Error ? error.message : "处理任务时发生未知错误。";
        this.database.failTask(task.id, code, message);
      }
    }
  }
}
