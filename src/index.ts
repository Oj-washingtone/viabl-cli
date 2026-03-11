#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import { createServer } from "net";

// ─── Constants ────────────────────────────────────────────────────────────────

const GITHUB_REPO = "Oj-washingtone/viabl-releases";
const HOME_DIR = join(homedir(), ".viabl");
const RENDERER_DIR = join(HOME_DIR, "renderer");
const CONTENT_SERVER_DIR = join(RENDERER_DIR, "content-server");
const VERSION_FILE = join(HOME_DIR, "version.json");

// ─── Version Helpers ──────────────────────────────────────────────────────────

interface VersionInfo {
  version: string;
  downloadedAt: string;
}

function getInstalledVersion(): string | null {
  try {
    if (!existsSync(VERSION_FILE)) return null;
    const info = JSON.parse(readFileSync(VERSION_FILE, "utf-8")) as VersionInfo;
    return info.version;
  } catch {
    return null;
  }
}

function saveInstalledVersion(version: string) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(
    VERSION_FILE,
    JSON.stringify(
      { version, downloadedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

// ─── Port Helpers ─────────────────────────────────────────────────────────────

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "0.0.0.0");
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

// ─── GitHub Release Helpers ───────────────────────────────────────────────────

async function getLatestRelease(): Promise<{
  version: string;
  downloadUrl: string;
}> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );

  if (res.status === 404) {
    throw new Error(
      `Repository or release not found: ${GITHUB_REPO}\n` +
        `  Make sure the releases repo is public and has at least one release.`,
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

  const asset = data.assets.find(
    (a) => a.name === "renderer-standalone.tar.gz",
  );

  if (!asset) {
    throw new Error(
      `renderer-standalone.tar.gz not found in release ${data.tag_name}.\n` +
        `  Make sure the GitHub Actions release workflow ran successfully.`,
    );
  }

  return { version: data.tag_name, downloadUrl: asset.browser_download_url };
}

// ─── Download + Extract ───────────────────────────────────────────────────────

async function downloadAndExtract(
  downloadUrl: string,
  destDir: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  onProgress("Downloading renderer...");

  const res = await fetch(downloadUrl);
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
        onProgress(`Downloading renderer... ${pct}% (${mb} MB)`);
      }
      cb(null, chunk);
    },
  });

  const gunzip = (await import("zlib")).createGunzip();
  const tar = await import("tar-fs");

  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    progressStream,
    gunzip,
    tar.extract(destDir),
  );
}

// ─── Wait for content server to be ready ─────────────────────────────────────

function waitForContentServer(port: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) {
          clearInterval(interval);
          resolve();
        }
      } catch {
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error("Content server did not start in time"));
        }
      }
    }, 300);
  });
}

// ─── Program ──────────────────────────────────────────────────────────────────

program.name("docs").description("Documentation renderer CLI").version("0.1.0");

// ─── Dev Command ─────────────────────────────────────────────────────────────

program
  .command("dev")
  .description("Start the docs development server")
  .option("-p, --port <port>", "Port to run on", "3000")
  .action(async (options) => {
    const userDir = process.cwd();

    // Validate docs.json exists
    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\n❌  No docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your docs folder\n"),
      );
      process.exit(1);
    }

    // Find available ports
    const requestedPort = parseInt(options.port, 10);
    const rendererPort = await findAvailablePort(requestedPort);
    const contentPort = await findAvailablePort(3001);

    if (rendererPort !== requestedPort) {
      console.log(
        chalk.yellow(
          `\n  Port ${requestedPort} in use — using ${rendererPort}`,
        ),
      );
    }

    console.log(chalk.bold("\n📖  Docs Dev Server"));
    console.log(chalk.dim(`📁  ${userDir}`));
    console.log(chalk.dim(`🌐  http://localhost:${rendererPort}\n`));

    const spinner = ora("Preparing...").start();

    // ── Install renderer if not present ──────────────────────────────────
    try {
      const installed = getInstalledVersion();

      if (!existsSync(RENDERER_DIR) || !installed) {
        spinner.text = "Fetching latest renderer version...";

        const { version, downloadUrl } = await getLatestRelease();

        await downloadAndExtract(downloadUrl, RENDERER_DIR, (msg) => {
          spinner.text = msg;
        });

        saveInstalledVersion(version);
        spinner.succeed(chalk.dim(`Renderer ${version} installed to ~/.viabl`));
      } else {
        spinner.succeed(chalk.dim(`Renderer ${installed} ready`));
      }
    } catch (err) {
      spinner.fail(chalk.red("Failed to install renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    // ── Validate required files ───────────────────────────────────────────
    const serverJs = join(RENDERER_DIR, "server.js");
    const contentServerJs = join(CONTENT_SERVER_DIR, "dist/index.js");

    if (!existsSync(serverJs)) {
      console.error(
        chalk.red("\n❌  server.js not found — try: docs update\n"),
      );
      process.exit(1);
    }

    if (!existsSync(contentServerJs)) {
      console.error(
        chalk.red("\n❌  content-server not found — try: docs update\n"),
      );
      process.exit(1);
    }

    // ── Start content server ──────────────────────────────────────────────
    const contentSpinner = ora("Starting content server...").start();

    const contentChild: ChildProcess = spawn("node", [contentServerJs], {
      env: {
        ...process.env,
        DOCS_ROOT: userDir,
        CONTENT_PORT: String(contentPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    contentChild.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Error") || text.includes("error")) {
        console.error(chalk.red(text));
      }
    });

    contentChild.on("exit", (code) => {
      if (code !== 0) {
        console.error(chalk.red(`\nContent server exited with code ${code}`));
        process.exit(1);
      }
    });

    // Wait for content server to be ready
    try {
      await waitForContentServer(contentPort);
      contentSpinner.succeed(
        chalk.dim(`Content server ready on port ${contentPort}`),
      );
    } catch {
      contentSpinner.fail(chalk.red("Content server failed to start"));
      contentChild.kill();
      process.exit(1);
    }

    // ── Start renderer ────────────────────────────────────────────────────
    const rendererSpinner = ora("Starting renderer...").start();
    let rendererReady = false;

    const rendererChild: ChildProcess = spawn("node", [serverJs], {
      env: {
        ...process.env,
        DOCS_ROOT: userDir,
        PORT: String(rendererPort),
        HOSTNAME: "0.0.0.0",
        NEXT_PUBLIC_SITE_URL: `http://localhost:${rendererPort}`,
        CONTENT_SERVER_URL: `http://localhost:${contentPort}`,
      },
      stdio: ["inherit", "pipe", "pipe"],
    });

    rendererChild.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (
        !rendererReady &&
        (text.includes("Local") ||
          text.includes("localhost") ||
          text.includes("Ready") ||
          text.includes("started server"))
      ) {
        rendererReady = true;
        rendererSpinner.succeed(
          chalk.green(`Ready at http://localhost:${rendererPort}`),
        );
        console.log(chalk.dim(`\n  Press ${chalk.white("Ctrl+C")} to stop\n`));
        return;
      }
      if (text.includes("Error:") || text.includes("Failed to compile")) {
        console.log(chalk.red(text));
      }
    });

    rendererChild.stderr?.on("data", (data: Buffer) => {
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

    rendererChild.on("exit", (code) => {
      contentChild.kill();
      process.exit(code ?? 0);
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────
    const shutdown = () => {
      rendererChild.kill();
      contentChild.kill();
      console.log(chalk.dim("\n\nServer stopped"));
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ─── Update Command ───────────────────────────────────────────────────────────

program
  .command("update")
  .description("Update the renderer to the latest version")
  .action(async () => {
    const spinner = ora("Checking for updates...").start();

    try {
      const { version, downloadUrl } = await getLatestRelease();
      const installed = getInstalledVersion();

      if (installed === version && existsSync(RENDERER_DIR)) {
        spinner.succeed(chalk.green(`Already on latest version ${version}`));
        return;
      }

      spinner.text = installed
        ? `Updating from ${installed} → ${version}...`
        : `Installing renderer ${version}...`;

      await downloadAndExtract(downloadUrl, RENDERER_DIR, (msg) => {
        spinner.text = msg;
      });

      saveInstalledVersion(version);
      spinner.succeed(chalk.green(`Renderer updated to ${version}`));
    } catch (err) {
      spinner.fail(chalk.red("Update failed"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }
  });

// ─── Clear Cache Command ──────────────────────────────────────────────────────

program
  .command("clear-cache")
  .description("Remove cached renderer — will re-download on next run")
  .action(async () => {
    const spinner = ora("Clearing cache...").start();
    try {
      if (existsSync(HOME_DIR)) {
        rmSync(HOME_DIR, { recursive: true, force: true });
      }
      spinner.succeed(
        chalk.green(
          "Cache cleared — renderer will re-download on next `docs dev`",
        ),
      );
    } catch (err) {
      spinner.fail(chalk.red("Failed to clear cache"));
      console.error(err);
      process.exit(1);
    }
  });

// ─── Version Info Command ─────────────────────────────────────────────────────

program
  .command("version-info")
  .description("Show installed renderer version")
  .action(() => {
    const installed = getInstalledVersion();
    if (!installed) {
      console.log(
        chalk.dim(
          "\nNo renderer installed — run `docs dev` to install automatically\n",
        ),
      );
    } else {
      const info = JSON.parse(
        readFileSync(VERSION_FILE, "utf-8"),
      ) as VersionInfo;
      console.log(
        chalk.bold(`\n📦  Renderer version: ${chalk.green(info.version)}`),
      );
      console.log(
        chalk.dim(
          `    Installed: ${new Date(info.downloadedAt).toLocaleString()}\n`,
        ),
      );
    }
  });

program.parse();
