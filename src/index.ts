#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { ChildProcess } from "child_process";
import spawn from "cross-spawn";

import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import { createServer } from "net";
import { createInterface } from "readline";
import { startScript } from "./startScript";
const { version } = require("../package.json");

const RELEASES_REPO = "Oj-washingtone/viabl-releases";
const HOME_DIR = join(homedir(), ".viabl");
const RENDERER_DIR = join(HOME_DIR, "renderer");
const CONTENT_SERVER_DIR = join(HOME_DIR, "content-server");
const VERSION_FILE = join(HOME_DIR, "version.json");

let _zlib: typeof import("zlib") | null = null;
let _tar: typeof import("tar-fs") | null = null;

async function getZlib() {
  if (!_zlib) _zlib = await import("zlib");
  return _zlib;
}

async function getTar() {
  if (!_tar) _tar = await import("tar-fs");
  return _tar;
}

const activeTempDirs = new Set<string>();
let earlyAbortController: AbortController | null = null;
let activeSpinner: Ora | null = null;

function registerEarlyShutdown() {
  earlyAbortController = new AbortController();

  const handler = () => {
    earlyAbortController?.abort();

    if (activeSpinner) activeSpinner.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();

    console.log(chalk.dim("\n  Cancelled"));

    for (const dir of activeTempDirs) {
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

interface VersionInfo {
  renderer: string | null;
  contentServer: string | null;
  downloadedAt: string;
}

function getVersionInfo(): VersionInfo {
  try {
    if (!existsSync(VERSION_FILE)) {
      return { renderer: null, contentServer: null, downloadedAt: "" };
    }
    return JSON.parse(readFileSync(VERSION_FILE, "utf-8")) as VersionInfo;
  } catch {
    return { renderer: null, contentServer: null, downloadedAt: "" };
  }
}

function saveVersionInfo(info: Partial<VersionInfo>) {
  mkdirSync(HOME_DIR, { recursive: true });
  const current = getVersionInfo();
  writeFileSync(
    VERSION_FILE,
    JSON.stringify(
      { ...current, ...info, downloadedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (await isPortInUse(port)) {
    console.log(chalk.dim(`  Port ${port} in use, trying ${port + 1}...`));
    port++;
  }
  return port;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 1500,
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (earlyAbortController?.signal.aborted) throw err;
      if (attempt === retries) throw err;
      await new Promise((res) => setTimeout(res, delayMs * attempt));
    }
  }
  throw new Error("unreachable");
}

// GitHub Release Helpers

async function getLatestAsset(
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

// Download + Extract

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

async function downloadAndExtract(
  downloadUrl: string,
  destDir: string,
  label: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  const tempDir = `${destDir}_tmp_${Date.now()}`;
  activeTempDirs.add(tempDir);

  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });

  mkdirSync(tempDir, { recursive: true });

  const signal = earlyAbortController?.signal;
  const throttledProgress = throttle(onProgress, 100);

  try {
    onProgress(`Downloading ${label}...`);

    const res = await fetch(downloadUrl, {
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
          throttledProgress(`Downloading ${label}... ${pct}% (${mb} MB)`);
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
      renameSync(tempDir, destDir);
    } catch {
      const { cpSync } = await import("fs");
      cpSync(tempDir, destDir, { recursive: true });
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err: any) {
    if (earlyAbortController?.signal.aborted) {
      throw new Error("__ABORTED__");
    }
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  } finally {
    activeTempDirs.delete(tempDir);
  }
}

function waitForContentServer(port: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    let fetchAbort: AbortController | null = null;

    const interval = setInterval(async () => {
      fetchAbort = new AbortController();
      const fetchTimeout = setTimeout(() => fetchAbort?.abort(), 2000);

      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: fetchAbort.signal,
        });
        clearTimeout(fetchTimeout);
        if (res.ok) {
          clearInterval(interval);
          resolve();
        }
      } catch {
        clearTimeout(fetchTimeout);
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error("Content server did not start in time"));
        }
      }
    }, 300);
  });
}

async function ensureRenderer(spinner: Ora): Promise<void> {
  activeSpinner = spinner;
  const { renderer: installedVersion } = getVersionInfo();

  spinner.text = "Checking renderer...";

  const { version, downloadUrl } = await withRetry(() =>
    getLatestAsset("renderer-standalone.tar.gz"),
  );

  if (installedVersion === version && existsSync(RENDERER_DIR)) {
    spinner.succeed(chalk.dim(`Renderer ${version} ready`));
    activeSpinner = null;
    return;
  }

  spinner.text = installedVersion
    ? `Updating renderer ${installedVersion} → ${version}...`
    : `Installing renderer ${version}...`;

  await downloadAndExtract(downloadUrl, RENDERER_DIR, "renderer", (msg) => {
    spinner.text = msg;
  });

  saveVersionInfo({ renderer: version });
  spinner.succeed(chalk.dim(`Renderer ${version} installed`));
  activeSpinner = null;
}

async function ensureContentServer(spinner: Ora): Promise<void> {
  activeSpinner = spinner;
  const { contentServer: installedVersion } = getVersionInfo();

  spinner.text = "Checking content server...";

  const { version, downloadUrl } = await withRetry(() =>
    getLatestAsset("content-server.tar.gz"),
  );

  if (installedVersion === version && existsSync(CONTENT_SERVER_DIR)) {
    spinner.succeed(chalk.dim(`Content server ${version} ready`));
    activeSpinner = null;
    return;
  }

  spinner.text = installedVersion
    ? `Updating content server ${installedVersion} → ${version}...`
    : `Installing content server ${version}...`;

  await downloadAndExtract(
    downloadUrl,
    CONTENT_SERVER_DIR,
    "content server",
    (msg) => {
      spinner.text = msg;
    },
  );

  saveVersionInfo({ contentServer: version });
  spinner.succeed(chalk.dim(`Content server ${version} installed`));
  activeSpinner = null;
}

// Init

const STARTER_REPO = "Oj-washingtone/viabl-starter";

async function downloadStarter(
  destDir: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress("Fetching starter template...");

  const tarUrl = `https://api.github.com/repos/${STARTER_REPO}/tarball/main`;
  const signal = earlyAbortController?.signal;
  const throttledProgress = throttle(onProgress, 100);

  // Track destDir for cleanup on abort
  activeTempDirs.add(destDir);

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

    const strip = tar.extract(destDir, {
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
    if (earlyAbortController?.signal.aborted) {
      throw new Error("__ABORTED__");
    }
    throw err;
  } finally {
    activeTempDirs.delete(destDir);
  }
}

async function gitInit(projectDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    child.on("error", () => reject(new Error("git not found")));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("git init failed")),
    );
  });
}

async function gitCommit(projectDir: string, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const add = spawn("git", ["add", "."], {
      cwd: projectDir,
      stdio: "ignore",
    });
    add.on("error", () => reject(new Error("git not found")));
    add.on("exit", (code) => {
      if (code !== 0) return reject(new Error("git add failed"));
      const commit = spawn("git", ["commit", "-m", message], {
        cwd: projectDir,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Viabl",
          GIT_AUTHOR_EMAIL: "init@viabl.dev",
          GIT_COMMITTER_NAME: "Viabl",
          GIT_COMMITTER_EMAIL: "init@viabl.dev",
        },
      });
      commit.on("exit", (c) =>
        c === 0 ? resolve() : reject(new Error("git commit failed")),
      );
    });
  });
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });

    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

async function runEnsureSteps(commands: {
  renderer: boolean;
  contentServer: boolean;
}): Promise<boolean> {
  if (commands.renderer) {
    const spinner = ora("Checking renderer...").start();
    try {
      await ensureRenderer(spinner);
    } catch (err: any) {
      if (err?.message === "__ABORTED__") return false;
      spinner.fail(chalk.red("Failed to install renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      return false;
    }
  }

  if (commands.contentServer) {
    const spinner = ora("Checking content server...").start();
    try {
      await ensureContentServer(spinner);
    } catch (err: any) {
      if (err?.message === "__ABORTED__") return false;
      spinner.fail(chalk.red("Failed to install content server"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      return false;
    }
  }

  return true;
}

program
  .name("viabl")
  .description("Viabl documentation renderer CLI")
  .version(version);

// Init Command

program
  .command("init [project-name]")
  .description("Create a new Viabl documentation project")
  .action(async (projectName?: string) => {
    registerEarlyShutdown();

    console.log(chalk.bold("\nCreate a new Viabl project\n"));

    if (!projectName) {
      projectName = await prompt(
        chalk.white("  What is your project named? ") + chalk.dim("(my-docs) "),
      );
      if (!projectName) projectName = "my-docs";
    }

    projectName = projectName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const projectDir = join(process.cwd(), projectName);

    if (existsSync(projectDir)) {
      console.error(chalk.red(`\nFolder '${projectName}' already exists.\n`));
      process.exit(1);
    }

    mkdirSync(projectDir, { recursive: true });

    const spinner = ora("Fetching starter template...").start();
    activeSpinner = spinner;

    try {
      await downloadStarter(projectDir, (msg) => {
        spinner.text = msg;
      });
      spinner.succeed(chalk.dim("Starter template downloaded"));
    } catch (err: any) {
      spinner.fail(chalk.red("Failed to download starter template"));
      if (err?.message !== "__ABORTED__") {
        console.error(err instanceof Error ? chalk.dim(err.message) : err);
      }
      rmSync(projectDir, { recursive: true, force: true });
      process.exit(1);
    } finally {
      activeSpinner = null;
    }

    const gitSpinner = ora("Initialising git repository...").start();
    try {
      await gitInit(projectDir);
      await gitCommit(projectDir, "Initial commit from Viabl");
      gitSpinner.succeed(chalk.dim("Git repository initialised"));
    } catch {
      gitSpinner.fail(chalk.dim("Git init skipped — git not found"));
    }

    console.log(chalk.green(`\n✔  Created ${projectName}\n`));
    console.log(chalk.white("  Next steps:\n"));
    console.log(chalk.dim(`    cd ${projectName}`));
    console.log(chalk.dim("    viabl dev\n"));
    console.log(
      chalk.dim(
        `  Edit ${chalk.white("docs.json")} to configure your project.`,
      ),
    );
    console.log(
      chalk.dim(
        `  Add pages as ${chalk.white(".mdx")} files and reference them in navigation.\n`,
      ),
    );
  });

// Dev Command

program
  .command("dev")
  .description("Start the viabl development server")
  .option("-p, --port <port>", "Port to run on", "7777")
  .action(async (options) => {
    const userDir = process.cwd();
    const earlyShutdownHandler = registerEarlyShutdown();

    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\nNo docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your documentation folder\n"),
      );
      process.exit(1);
    }

    const requestedPort = parseInt(options.port, 10);
    const rendererPort = await findAvailablePort(requestedPort);
    const contentPort = await findAvailablePort(rendererPort + 1);

    if (rendererPort !== requestedPort) {
      console.log(
        chalk.yellow(
          `\n  ⚠ Port ${requestedPort} is in use, using port ${rendererPort} instead.`,
        ),
      );
    }

    console.log(chalk.bold("\nViabl Dev Server"));
    console.log(chalk.dim(`${userDir}`));
    console.log(chalk.dim(`\n`));

    const ensured = await runEnsureSteps({
      renderer: true,
      contentServer: true,
    });

    if (!ensured) process.exit(1);

    const serverJs = join(RENDERER_DIR, "server.js");
    const contentServerJs = join(CONTENT_SERVER_DIR, "dist", "index.js");

    if (!existsSync(serverJs)) {
      console.error(chalk.red("\nserver.js not found — try: viabl update\n"));
      process.exit(1);
    }

    if (!existsSync(contentServerJs)) {
      console.error(
        chalk.red(
          "\ncontent-server/dist/index.js not found — try: viabl update\n",
        ),
      );
      process.exit(1);
    }

    // Hand off from early shutdown to full server shutdown
    process.removeListener("SIGINT", earlyShutdownHandler);
    process.removeListener("SIGTERM", earlyShutdownHandler);

    const contentSpinner = ora("Starting content server...").start();

    let contentChild: ChildProcess;
    try {
      contentChild = spawn("node", [contentServerJs], {
        env: {
          ...process.env,
          DOCS_ROOT: userDir,
          NODE_ENV: "development",
          CONTENT_PORT: String(contentPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      contentSpinner.fail(
        chalk.red(
          "Could not start content server — is node installed and in your PATH?",
        ),
      );
      process.exit(1);
    }

    contentChild!.on("error", (err) => {
      console.error(
        chalk.red(
          `\nContent server spawn error: ${err.message}\n  Is node installed and in your PATH?`,
        ),
      );
    });

    contentChild!.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Error") || text.includes("error")) {
        console.error(chalk.red(text));
      }
    });

    try {
      await waitForContentServer(contentPort, 20000);
      contentSpinner.succeed(
        chalk.dim(`Content server running on port ${contentPort}`),
      );
    } catch {
      contentSpinner.fail(chalk.red("Content server failed to start"));
      contentChild!.kill();
      process.exit(1);
    }

    // Start renderer
    const startSpinner = ora("Starting renderer...").start();
    let rendererReady = false;

    let rendererChild: ChildProcess;
    try {
      rendererChild = spawn("node", [serverJs], {
        env: {
          ...process.env,
          DOCS_ROOT: userDir,
          PORT: String(rendererPort),
          HOSTNAME: "0.0.0.0",
          NEXT_PUBLIC_SITE_URL: `http://localhost:${rendererPort}`,
          CONTENT_SERVER_URL: `http://localhost:${contentPort}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      startSpinner.fail(
        chalk.red(
          "Could not start renderer — is node installed and in your PATH?",
        ),
      );
      contentChild!.kill();
      process.exit(1);
    }

    rendererChild!.on("error", (err) => {
      console.error(
        chalk.red(
          `\nRenderer spawn error: ${err.message}\n  Is node installed and in your PATH?`,
        ),
      );
    });

    rendererChild!.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (
        !rendererReady &&
        (text.includes("Local") ||
          text.includes("localhost") ||
          text.includes("Ready") ||
          text.includes("started server"))
      ) {
        rendererReady = true;
        startSpinner.succeed(
          chalk.green(`Ready at http://localhost:${rendererPort}`),
        );
        console.log(chalk.dim(`\n  Press ${chalk.white("Ctrl+C")} to stop\n`));
        return;
      }
      if (text.includes("Error:") || text.includes("Failed to compile")) {
        console.log(chalk.red(text));
      }
    });

    rendererChild!.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const skip = [
        "ExperimentalWarning",
        "DeprecationWarning",
        "punycode",
        "▲ Next.js",
        "- Local:",
        "- Network:",
        "- Environments",
        "Ready in",
        "warn -",
        "info -",
      ];
      if (skip.some((s) => text.includes(s))) return;
      if (text.includes("Error") || text.includes("error")) {
        console.error(chalk.red(text));
      }
    });

    let isShuttingDown = false;

    rendererChild!.on("exit", (code) => {
      if (isShuttingDown) return;
      contentChild!.kill();
      process.exit(code ?? 0);
    });

    const shutdown = () => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      const spinner = ora("Stopping servers...").start();

      rendererChild!.stderr?.removeAllListeners("data");
      rendererChild!.stdout?.removeAllListeners("data");

      rendererChild!.kill("SIGTERM");

      rendererChild!.once("exit", () => {
        contentChild!.kill("SIGTERM");

        const done = () => {
          spinner.succeed(chalk.dim("Servers stopped"));
          setTimeout(() => process.exit(0), 100);
        };

        contentChild!.once("exit", done);

        setTimeout(() => {
          contentChild!.kill("SIGKILL");
          done();
        }, 3000).unref();
      });

      // Safety net
      setTimeout(() => {
        rendererChild!.kill("SIGKILL");
        contentChild!.kill("SIGKILL");
        spinner.succeed(chalk.dim("Servers stopped"));
        setTimeout(() => process.exit(0), 100);
      }, 5000).unref();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// Update Command

program
  .command("update")
  .description("Update renderer and content server to latest versions")
  .action(async () => {
    registerEarlyShutdown();

    console.log(chalk.bold("\nChecking for updates...\n"));

    await runEnsureSteps({ renderer: true, contentServer: true });

    console.log(chalk.dim("\nDone.\n"));
  });

// Clear Cache Command

program
  .command("clear-cache")
  .description("Remove all cached files — will re-download on next run")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (options) => {
    if (!options.force) {
      const answer = await prompt(
        chalk.yellow(
          "  This will remove the cached renderer and content server.\n" +
            "  They will be re-downloaded on next run.\n\n" +
            "  Continue? (y/N) ",
        ),
      );
      if (answer.toLowerCase() !== "y") {
        console.log(chalk.dim("\n  Cancelled\n"));
        process.exit(0);
      }
    }

    const spinner = ora("Clearing cache...").start();
    try {
      if (existsSync(HOME_DIR)) {
        rmSync(HOME_DIR, { recursive: true, force: true });
      }
      spinner.succeed(
        chalk.green("Cache cleared — will re-download on next `viabl dev`"),
      );
    } catch (err) {
      spinner.fail(chalk.red("Failed to clear cache"));
      console.error(err);
      process.exit(1);
    }
  });

// Version Info Command

program
  .command("version-info")
  .description("Show installed versions")
  .action(() => {
    const info = getVersionInfo();

    if (!info.renderer && !info.contentServer) {
      console.log(
        chalk.dim(
          "\nNothing installed — run `viabl dev` to install automatically\n",
        ),
      );
      return;
    }

    console.log(chalk.bold("\n📦 Installed versions:"));
    console.log(
      `  Renderer:       ${info.renderer ? chalk.green(info.renderer) : chalk.dim("not installed")}`,
    );
    console.log(
      `  Content server: ${info.contentServer ? chalk.green(info.contentServer) : chalk.dim("not installed")}`,
    );
    if (info.downloadedAt) {
      console.log(
        chalk.dim(
          `  Last updated:   ${new Date(info.downloadedAt).toLocaleString()}`,
        ),
      );
    }
    console.log();
  });

// Build Command

program
  .command("build")
  .description("Build a production-ready bundle of your docs")
  .action(async () => {
    const userDir = process.cwd();
    const BUILD_DIR = join(userDir, ".viabl");

    registerEarlyShutdown();

    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\n  No docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your documentation folder\n"),
      );
      process.exit(1);
    }

    console.log(chalk.bold("\n📦  Viabl Build\n"));

    const ensured = await runEnsureSteps({
      renderer: true,
      contentServer: true,
    });
    if (!ensured) process.exit(1);

    const buildSpinner = ora("Assembling build output...").start();
    try {
      if (existsSync(BUILD_DIR))
        rmSync(BUILD_DIR, { recursive: true, force: true });
      mkdirSync(BUILD_DIR, { recursive: true });

      const { cp } = await import("fs/promises");

      await cp(RENDERER_DIR, join(BUILD_DIR, "renderer"), {
        recursive: true,
        dereference: true,
      });
      await cp(CONTENT_SERVER_DIR, join(BUILD_DIR, "content-server"), {
        recursive: true,
        dereference: true,
      });

      const excluded = new Set([".git", "node_modules", ".viabl"]);
      const docsDir = join(BUILD_DIR, "docs");
      mkdirSync(docsDir, { recursive: true });

      for (const item of readdirSync(userDir)) {
        if (excluded.has(item)) continue;
        await cp(join(userDir, item), join(docsDir, item), { recursive: true });
      }

      writeFileSync(join(BUILD_DIR, "start.js"), startScript, { mode: 0o755 });
      buildSpinner.succeed(chalk.dim("Build output ready"));
    } catch (err) {
      buildSpinner.fail(chalk.red("Build failed"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    console.log(chalk.green("\n✔  Build complete\n"));
    console.log(chalk.white("  Output: ") + chalk.dim(".viabl/\n"));
    console.log(chalk.white("  To run locally:"));
    console.log(chalk.dim("    node .viabl/start.js\n"));
    console.log(chalk.dim("    PORT=<YOUR_PORT> node .viabl/start.js\n"));
  });

// Start Command

program
  .command("start")
  .description("Run the production build")
  .option("-p, --port <port>", "Port to run on", "7777")
  .action((options) => {
    const buildDir = join(process.cwd(), ".viabl");

    if (!existsSync(buildDir)) {
      console.error(chalk.red("\n No build found — run: viabl build\n"));
      process.exit(1);
    }

    const startJs = join(buildDir, "start.js");

    if (!existsSync(startJs)) {
      console.error(chalk.red("\n start.js not found — run: viabl build\n"));
      process.exit(1);
    }

    let child: ChildProcess;
    try {
      child = spawn("node", [startJs], {
        env: { ...process.env, PORT: options.port, NODE_ENV: "production" },
        stdio: "inherit",
      });
    } catch (err) {
      console.error(
        chalk.red(
          "\nCould not start server — is node installed and in your PATH?\n",
        ),
      );
      process.exit(1);
    }

    child!.on("error", (err) => {
      console.error(
        chalk.red(
          `\nSpawn error: ${err.message}\n  Is node installed and in your PATH?`,
        ),
      );
    });

    child!.on("exit", (code) => process.exit(code ?? 0));

    let isShuttingDown = false;
    const shutdown = () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      child!.kill("SIGTERM");
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
