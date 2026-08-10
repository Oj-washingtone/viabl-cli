import { existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { pipeline } from "stream/promises";
import { Transform } from "stream";

import { RELEASES_REPO, STARTER_REPO, RELEASE_CACHE_FILE, HOME_DIR } from "./constants";
import { getZlib } from "./utils/getZlib";
import { getTar } from "./utils/getTar";

interface ReleaseData {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

interface CacheFileFormat {
  etag?: string;
  timestamp: number;
  data: ReleaseData;
}

function readReleaseCache(): CacheFileFormat | null {
  try {
    if (existsSync(RELEASE_CACHE_FILE)) {
      const content = readFileSync(RELEASE_CACHE_FILE, "utf-8");
      return JSON.parse(content) as CacheFileFormat;
    }
  } catch {}
  return null;
}

function writeReleaseCache(data: ReleaseData, etag?: string): void {
  try {
    if (!existsSync(HOME_DIR)) {
      mkdirSync(HOME_DIR, { recursive: true });
    }
    const cache: CacheFileFormat = {
      etag,
      timestamp: Date.now(),
      data,
    };
    writeFileSync(RELEASE_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch {}
}

export async function getLatestAsset(
  assetName: string,
): Promise<{ version: string; downloadUrl: string }> {
  // 1. Primary approach: Query public GitHub release download redirect (bypasses REST API rate limits completely, no token needed)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const latestDownloadUrl = `https://github.com/${RELEASES_REPO}/releases/latest/download/${assetName}`;
      const res = await fetch(latestDownloadUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "viabl-cli/0.1.0",
        },
      });

      if (res.status === 302 || res.status === 301) {
        const location = res.headers.get("location");
        const tagMatch = location?.match(/\/releases\/download\/([^/]+)\//);
        if (tagMatch && tagMatch[1]) {
          const version = tagMatch[1];
          const downloadUrl = location || latestDownloadUrl;
          return { version, downloadUrl };
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {}

  // 2. Fallback approach: GitHub REST API or local release cache
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const cached = readReleaseCache();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "viabl-cli/0.1.0",
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  let releaseData: ReleaseData | null = null;
  let newEtag: string | undefined = cached?.etag;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
      {
        signal: controller.signal,
        headers,
      },
    );

    if (res.status === 304 && cached?.data) {
      releaseData = cached.data;
    } else if (res.ok) {
      const etagHeader = res.headers.get("etag");
      if (etagHeader) newEtag = etagHeader;
      releaseData = (await res.json()) as ReleaseData;
      writeReleaseCache(releaseData, newEtag);
    } else if ((res.status === 403 || res.status === 429) && cached?.data) {
      console.warn(
        `\n⚠️ GitHub API rate limit exceeded. Using cached release data (${cached.data.tag_name}).`,
      );
      releaseData = cached.data;
    } else if (res.status === 404) {
      throw new Error(
        `Repository or release not found: ${RELEASES_REPO}\n` +
          `  Make sure the releases repo is public and has at least one release.`,
      );
    } else if (res.status === 403 || res.status === 429) {
      throw new Error(
        `GitHub API rate limit exceeded. Wait a few minutes and try again.`,
      );
    } else {
      throw new Error(
        `Could not fetch release info from GitHub: ${res.statusText}`,
      );
    }
  } catch (err: any) {
    if (cached?.data) {
      console.warn(
        `\n⚠️ Failed to fetch latest release from GitHub. Using cached release data (${cached.data.tag_name}).`,
      );
      releaseData = cached.data;
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

  const asset = releaseData.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(
      `${assetName} not found in release ${releaseData.tag_name}.\n` +
        `  Make sure the GitHub Actions release workflow ran successfully.`,
    );
  }

  return { version: releaseData.tag_name, downloadUrl: asset.browser_download_url };
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
      redirect: "follow",
      signal,
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "viabl-cli/0.1.0",
      },
    });

    if (!res.ok)
      throw new Error(`Failed to download ${options.label}: ${res.statusText}`);
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

    const extractStream = tar.extract(tempDir);

    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      progressStream,
      gunzip,
      extractStream,
      ...(signal ? [{ signal }] : []),
    );

    options.onProgress(`Extracting ${options.label}...`);
    mkdirSync(options.destDir, { recursive: true });

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

  const tarUrl = `https://codeload.github.com/${STARTER_REPO}/tar.gz/refs/heads/main`;
  const signal = options.earlyAbortController?.signal;
  const throttledProgress = throttle(options.onProgress, 100);

  // Track destDir for cleanup on abort (only if not current working directory)
  if (resolve(options.destDir) !== process.cwd()) {
    options.activeTempDirs.add(options.destDir);
  }

  try {
    const res = await fetch(tarUrl, {
      redirect: "follow",
      signal,
      headers: {
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
