import { existsSync, mkdirSync, rmSync, renameSync } from "fs";

import { pipeline } from "stream/promises";
import { Transform } from "stream";

import { RELEASES_REPO, STARTER_REPO } from "./constants";
import { getZlib } from "./utils/getZlib";
import { getTar } from "./utils/getTar";

export async function getLatestAsset(
  assetName: string,
): Promise<{ version: string; downloadUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
      {
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "viabl-cli/0.1.0",
        },
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 404) {
    throw new Error(
      `Repository or release not found: ${RELEASES_REPO}\n` +
        `  Make sure the releases repo is public and has at least one release.`,
    );
  }

  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub API rate limit exceeded. Wait a few minutes and try again.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Could not fetch release info from GitHub: ${res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const asset = data.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(
      `${assetName} not found in release ${data.tag_name}.\n` +
        `  Make sure the GitHub Actions release workflow ran successfully.`,
    );
  }

  return { version: data.tag_name, downloadUrl: asset.browser_download_url };
}

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  return ((...args: any[]) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  }) as T;
}
interface DownloadOptions {
  downloadUrl: string;
  destDir: string;
  label: string;
  activeTempDirs: Set<string>;
  onProgress: (msg: string) => void;
  earlyAbortController: AbortController | null;
}

export async function downloadAndExtract(
  options: DownloadOptions,
): Promise<void> {
  const tempDir = `${options.destDir}_tmp_${Date.now()}`;
  options.activeTempDirs.add(tempDir);

  if (existsSync(options.destDir))
    rmSync(options.destDir, { recursive: true, force: true });
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });

  mkdirSync(tempDir, { recursive: true });

  const signal = options.earlyAbortController?.signal;
  const throttledProgress = throttle(options.onProgress, 100);

  try {
    options.onProgress(`Downloading ${options.label}...`);

    const res = await fetch(options.downloadUrl, {
      signal,
      headers: { "User-Agent": "viabl-cli/0.1.0" },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
    if (!res.body) throw new Error("Response body is empty");

    const totalSize = Number(res.headers.get("content-length") ?? 0);
    let downloaded = 0;

    const progressStream = new Transform({
      transform(chunk, _, cb) {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const pct = Math.round((downloaded / totalSize) * 100);
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          throttledProgress(
            `Downloading ${options.label}... ${pct}% (${mb} MB)`,
          );
        }
        cb(null, chunk);
      },
    });

    const zlib = await getZlib();
    const tar = await getTar();
    const gunzip = zlib.createGunzip();

    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      progressStream,
      gunzip,
      tar.extract(tempDir),
      ...(signal ? [{ signal }] : []),
    );

    try {
      renameSync(tempDir, options.destDir);
    } catch {
      const { cpSync } = await import("fs");
      cpSync(tempDir, options.destDir, { recursive: true });
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err: any) {
    rmSync(tempDir, { recursive: true, force: true });
    if (options.earlyAbortController?.signal.aborted) {
      throw new Error("__ABORTED__");
    }
    throw err;
  } finally {
    options.activeTempDirs.delete(tempDir);
  }
}

interface DownloadStarterOptions {
  destDir: string;
  onProgress: (msg: string) => void;
  activeTempDirs: Set<string>;
  earlyAbortController: AbortController | null;
}

export async function downloadStarter(
  options: DownloadStarterOptions,
): Promise<void> {
  options.onProgress("Fetching starter template...");

  const tarUrl = `https://api.github.com/repos/${STARTER_REPO}/tarball/main`;
  const signal = options.earlyAbortController?.signal;
  const throttledProgress = throttle(options.onProgress, 100);

  // Track destDir for cleanup on abort
  options.activeTempDirs.add(options.destDir);

  try {
    const res = await fetch(tarUrl, {
      redirect: "follow",
      signal,
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "viabl-cli/0.1.0",
      },
    });

    if (!res.ok)
      throw new Error(
        `Failed to download starter: ${res.status} ${res.statusText}`,
      );
    if (!res.body) throw new Error("Response body is empty");

    const totalSize = Number(res.headers.get("content-length") ?? 0);
    let downloaded = 0;

    const progressStream = new Transform({
      transform(chunk, _, cb) {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const pct = Math.round((downloaded / totalSize) * 100);
          throttledProgress(`Downloading starter... ${pct}%`);
        }
        cb(null, chunk);
      },
    });

    const zlib = await getZlib();
    const tar = await getTar();
    const gunzip = zlib.createGunzip();

    const strip = tar.extract(options.destDir, {
      map: (header) => {
        header.name = header.name.split("/").slice(1).join("/");
        return header;
      },
    });

    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      progressStream,
      gunzip,
      strip,
      ...(signal ? [{ signal }] : []),
    );
  } catch (err: any) {
    if (options.earlyAbortController?.signal.aborted) {
      throw new Error("__ABORTED__");
    }
    throw err;
  } finally {
    options.activeTempDirs.delete(options.destDir);
  }
}
