import { ensureRenderer, ensureRendererSources } from "../render";
import { ensureContentServer } from "../server";
import chalk from "chalk";
import ora from "ora";
import { type EnsureOptions } from "../types/assets";

export async function runSteps(
  commands: {
    renderer: boolean;
    rendererSources: boolean;
    contentServer: boolean;
  },
  context: Pick<EnsureOptions, "activeTempDirs" | "earlyAbortController">,
): Promise<boolean> {
  if (commands.renderer) {
    const spinner = ora("Checking renderer...").start();
    try {
      await ensureRenderer({ spinner, ...context });
    } catch (err: any) {
      if (err?.message === "__ABORTED__") {
        spinner.stop();
        return false;
      }
      spinner.fail(chalk.red("Failed to install renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      return false;
    }
  }

  if (commands.rendererSources) {
    const spinner = ora("Checking renderer sources...").start();
    try {
      await ensureRendererSources({ spinner, ...context });
    } catch (err: any) {
      if (err?.message === "__ABORTED__") return false;
      spinner.fail(chalk.red("Failed to install renderer sources"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      return false;
    }
  }

  if (commands.contentServer) {
    const spinner = ora("Checking content server...").start();
    try {
      await ensureContentServer({ spinner, ...context });
    } catch (err: any) {
      if (err?.message === "__ABORTED__") return false;
      spinner.fail(chalk.red("Failed to install content server"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      return false;
    }
  }

  return true;
}
