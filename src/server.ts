import chalk from "chalk";
import { type Ora } from "ora";
import { existsSync } from "fs";
import { downloadAndExtract, getLatestAsset } from "./assets";
import { CONTENT_SERVER_DIR } from "./constants";
import { getVersionInfo, saveVersionInfo } from "./version";
import { withRetry } from "./utils/retry";
import { type EnsureOptions } from "./types/assets";

export async function ensureContentServer(
  options: EnsureOptions,
): Promise<void> {
  const { spinner, activeTempDirs, earlyAbortController } = options;
  const { contentServer: installedVersion } = getVersionInfo();

  spinner.text = "Checking content server...";

  const { version, downloadUrl } = await withRetry(
    () => getLatestAsset("content-server.tar.gz"),
    3,
    1500,
    earlyAbortController ?? undefined,
  );

  if (installedVersion === version && existsSync(CONTENT_SERVER_DIR)) {
    spinner.succeed(chalk.dim(`Content server ${version} ready`));
    return;
  }

  spinner.text = installedVersion
    ? `Updating content server ${installedVersion} → ${version}...`
    : `Installing content server ${version}...`;

  await downloadAndExtract({
    downloadUrl,
    destDir: CONTENT_SERVER_DIR,
    label: "content server",
    activeTempDirs,
    earlyAbortController,
    onProgress: (msg) => {
      spinner.text = msg;
    },
  });

  saveVersionInfo({ contentServer: version });
  spinner.succeed(chalk.dim(`Content server ${version} installed`));
}

export function waitForServer(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now();

  const poll = async (): Promise<void> => {
    while (Date.now() - start < timeoutMs) {
      const fetchAbort = new AbortController();
      const fetchTimeout = setTimeout(() => fetchAbort.abort(), 2000);

      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: fetchAbort.signal,
        });
        clearTimeout(fetchTimeout);
        if (res.ok) {
          return;
        }
      } catch {
        clearTimeout(fetchTimeout);
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    throw new Error("Content server did not start in time");
  };

  return poll();
}
