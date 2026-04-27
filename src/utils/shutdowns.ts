import chalk from "chalk";
import { type Ora } from "ora";

import { existsSync, rmSync } from "fs";

interface ShutdownOptions {
  earlyAbortController: AbortController | null;
  activeTempDirs: Set<string>;
  activeSpinner: Ora | null;
}

export function registerEarlyShutdown(options: ShutdownOptions) {
  options.earlyAbortController = new AbortController();

  const handler = () => {
    options.earlyAbortController?.abort();

    if (options.activeSpinner) options.activeSpinner.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();

    console.log(chalk.dim("\n  Cancelled"));

    for (const dir of options.activeTempDirs) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch {}
    }

    process.exit(0);
  };

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return handler;
}
