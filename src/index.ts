#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { spawn, ChildProcess } from "child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import { createServer } from "net";
import { createInterface } from "readline";
import { startScript } from "./startScript";

// ─── Constants ────────────────────────────────────────────────────────────────

const RELEASES_REPO = "Oj-washingtone/viabl-releases";
const HOME_DIR = join(homedir(), ".viabl");
const RENDERER_DIR = join(HOME_DIR, "renderer");
const CONTENT_SERVER_DIR = join(HOME_DIR, "content-server");
const VERSION_FILE = join(HOME_DIR, "version.json");
const BUILD_DIR = join(process.cwd(), ".viabl");

// ─── Version Helpers ──────────────────────────────────────────────────────────

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
      {
        ...current,
        ...info,
        downloadedAt: new Date().toISOString(),
      },
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

async function getLatestAsset(
  assetName: string,
): Promise<{ version: string; downloadUrl: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
    { headers: { Accept: "application/vnd.github.v3+json" } },
  );

  if (res.status === 404) {
    throw new Error(
      `Repository or release not found: ${RELEASES_REPO}\n` +
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

  const asset = data.assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new Error(
      `${assetName} not found in release ${data.tag_name}.\n` +
        `  Make sure the GitHub Actions release workflow ran successfully.`,
    );
  }

  return { version: data.tag_name, downloadUrl: asset.browser_download_url };
}

// ─── Download + Extract ───────────────────────────────────────────────────────

async function downloadAndExtract(
  downloadUrl: string,
  destDir: string,
  label: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  onProgress(`Downloading ${label}...`);

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
        onProgress(`Downloading ${label}... ${pct}% (${mb} MB)`);
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

// ─── Install content server deps after extraction ─────────────────────────────

async function installContentServerDeps(
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress("Installing content server dependencies...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["ci", "--omit=dev"], {
      cwd: CONTENT_SERVER_DIR,
      stdio: "ignore",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ci failed with code ${code}`));
    });
  });
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

// ─── Ensure renderer is installed / up to date ───────────────────────────────

async function ensureRenderer(spinner: Ora): Promise<void> {
  const { renderer: installedVersion } = getVersionInfo();

  spinner.text = "Checking renderer...";
  const { version, downloadUrl } = await getLatestAsset(
    "renderer-standalone.tar.gz",
  );

  if (installedVersion === version && existsSync(RENDERER_DIR)) {
    spinner.succeed(chalk.dim(`Renderer ${version} ready`));
    return;
  }

  const action = installedVersion
    ? `Updating renderer ${installedVersion} → ${version}...`
    : `Installing renderer ${version}...`;

  spinner.text = action;

  await downloadAndExtract(downloadUrl, RENDERER_DIR, "renderer", (msg) => {
    spinner.text = msg;
  });

  saveVersionInfo({ renderer: version });
  spinner.succeed(chalk.dim(`Renderer ${version} installed`));
}

// ─── Ensure content server is installed / up to date ─────────────────────────

async function ensureContentServer(spinner: Ora): Promise<void> {
  const { contentServer: installedVersion } = getVersionInfo();

  spinner.text = "Checking content server...";
  const { version, downloadUrl } = await getLatestAsset(
    "content-server.tar.gz",
  );

  if (installedVersion === version && existsSync(CONTENT_SERVER_DIR)) {
    spinner.succeed(chalk.dim(`Content server ${version} ready`));
    return;
  }

  const action = installedVersion
    ? `Updating content server ${installedVersion} → ${version}...`
    : `Installing content server ${version}...`;

  spinner.text = action;

  await downloadAndExtract(
    downloadUrl,
    CONTENT_SERVER_DIR,
    "content server",
    (msg) => {
      spinner.text = msg;
    },
  );

  await installContentServerDeps((msg) => {
    spinner.text = msg;
  });

  saveVersionInfo({ contentServer: version });
  spinner.succeed(chalk.dim(`Content server ${version} installed`));
}

// ─── Init Helpers ─────────────────────────────────────────────────────────────

const STARTER_REPO = "Oj-washingtone/viabl-starter";

async function downloadStarter(
  destDir: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  onProgress("Fetching starter template...");

  // Get the tarball URL for the main branch
  const tarUrl = `https://api.github.com/repos/${STARTER_REPO}/tarball/main`;

  let res: Response;
  try {
    res = await fetch(tarUrl, {
      redirect: "follow",
      headers: { Accept: "application/vnd.github.v3+json" },
    });
  } catch (err) {
    throw new Error(`Network error downloading starter: ${String(err)}`);
  }

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
        onProgress(`Downloading starter... ${pct}%`);
      }
      cb(null, chunk);
    },
  });

  const gunzip = (await import("zlib")).createGunzip();
  const tar = await import("tar-fs");

  // GitHub tarballs extract into a folder like "Oj-washingtone-viabl-starter-abc1234/"
  // We need to strip that top-level folder and extract directly into destDir
  const strip = tar.extract(destDir, {
    map: (header) => {
      // Strip the first path component (the auto-generated folder name)
      header.name = header.name.split("/").slice(1).join("/");
      return header;
    },
  });

  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    progressStream,
    gunzip,
    strip,
  );
}

async function gitInit(projectDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["init"], { cwd: projectDir, stdio: "ignore" });
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
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Program ──────────────────────────────────────────────────────────────────

program
  .name("viabl")
  .description("Viabl documentation renderer CLI")
  .version("0.1.0");

// ─── Init Command ─────────────────────────────────────────────────────────────

program
  .command("init [project-name]")
  .description("Create a new Viabl documentation project")
  .action(async (projectName?: string) => {
    console.log(chalk.bold("\n📖  Create a new Viabl project\n"));

    // ── Get project name ──────────────────────────────────────────────────
    if (!projectName) {
      projectName = await prompt(
        chalk.white("  What is your project named? ") + chalk.dim("(my-docs) "),
      );
      if (!projectName) projectName = "my-docs";
    }

    // Sanitize — lowercase, hyphens only
    projectName = projectName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const projectDir = join(process.cwd(), projectName);

    // ── Check if folder already exists ───────────────────────────────────
    if (existsSync(projectDir)) {
      console.error(chalk.red(`\nFolder '${projectName}' already exists.\n`));
      process.exit(1);
    }

    mkdirSync(projectDir, { recursive: true });

    // ── Download starter ──────────────────────────────────────────────────
    const spinner = ora("Fetching starter template...").start();
    try {
      await downloadStarter(projectDir, (msg) => {
        spinner.text = msg;
      });
      spinner.succeed(chalk.dim("Starter template downloaded"));
    } catch (err) {
      spinner.fail(chalk.red("Failed to download starter template"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      rmSync(projectDir, { recursive: true, force: true });
      process.exit(1);
    }

    // ── Git init + initial commit ─────────────────────────────────────────
    const gitSpinner = ora("Initialising git repository...").start();
    try {
      await gitInit(projectDir);
      await gitCommit(projectDir, "Initial commit from Viabl");
      gitSpinner.succeed(chalk.dim("Git repository initialised"));
    } catch {
      gitSpinner.fail(chalk.dim("Git init skipped — git not found"));
    }

    // ── Done ──────────────────────────────────────────────────────────────
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

// ─── Dev Command ─────────────────────────────────────────────────────────────

program
  .command("dev")
  .description("Start the viabl development server")
  .option("-p, --port <port>", "Port to run on", "7777")
  .action(async (options) => {
    const userDir = process.cwd();

    // Validate docs.json exists
    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\nNo docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your documentation folder\n"),
      );
      process.exit(1);
    }

    // Find available ports
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

    console.log(chalk.bold("\n📖  Viabl Dev Server"));
    console.log(chalk.dim(`📁  ${userDir}`));
    console.log(chalk.dim(`🌐  http://localhost:${rendererPort}\n`));

    // ── Ensure renderer and content server are installed ─────────────────
    const rendererSpinner = ora("Checking renderer...").start();
    try {
      await ensureRenderer(rendererSpinner);
    } catch (err) {
      rendererSpinner.fail(chalk.red("Failed to install renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    const serverSpinner = ora("Checking content server...").start();
    try {
      await ensureContentServer(serverSpinner);
    } catch (err) {
      serverSpinner.fail(chalk.red("Failed to install content server"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    // ── Validate required files ───────────────────────────────────────────
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
      // if (code !== 0) {
      //   console.error(chalk.red(`\nContent server exited with code ${code}`));
      // }
    });

    try {
      await waitForContentServer(contentPort, 20000);
      contentSpinner.succeed(
        chalk.dim(`Content server running on port ${contentPort}`),
      );
    } catch {
      contentSpinner.fail(chalk.red("Content server failed to start"));
      contentChild.kill();
      process.exit(1);
    }

    // ── Start renderer ────────────────────────────────────────────────────
    const startSpinner = ora("Starting renderer...").start();
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

    let isShuttingDown = false;

    rendererChild.on("exit", (code) => {
      if (isShuttingDown) return;
      contentChild.kill();
      process.exit(code ?? 0);
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────
    const shutdown = () => {
      isShuttingDown = true;
      const spinner = ora("Stopping servers...").start();

      rendererChild.stderr?.removeAllListeners("data");
      rendererChild.stdout?.removeAllListeners("data");

      rendererChild.kill("SIGTERM");

      rendererChild.once("exit", () => {
        contentChild.kill("SIGTERM");

        const done = () => {
          spinner.succeed(chalk.dim("Servers stopped"));
          setTimeout(() => process.exit(0), 100);
        };

        contentChild.once("exit", done);

        setTimeout(() => {
          contentChild.kill("SIGKILL");
          done();
        }, 3000).unref();
      });

      // Safety net
      setTimeout(() => {
        rendererChild.kill("SIGKILL");
        contentChild.kill("SIGKILL");
        spinner.succeed(chalk.dim("Servers stopped"));
        setTimeout(() => process.exit(0), 100);
      }, 5000).unref();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ─── Update Command ───────────────────────────────────────────────────────────

program
  .command("update")
  .description("Update renderer and content server to latest versions")
  .action(async () => {
    console.log(chalk.bold("\n🔄  Checking for updates...\n"));

    // ── Renderer ─────────────────────────────────────────────────────────
    const rendererSpinner = ora("Checking renderer...").start();
    try {
      await ensureRenderer(rendererSpinner);
    } catch (err) {
      rendererSpinner.fail(chalk.red("Failed to update renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
    }

    // ── Content server ────────────────────────────────────────────────────
    const serverSpinner = ora("Checking content server...").start();
    try {
      await ensureContentServer(serverSpinner);
    } catch (err) {
      serverSpinner.fail(chalk.red("Failed to update content server"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
    }

    console.log(chalk.dim("\nDone.\n"));
  });

// ─── Clear Cache Command ──────────────────────────────────────────────────────

program
  .command("clear-cache")
  .description("Remove all cached files — will re-download on next run")
  .action(async () => {
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

// ─── Version Info Command ─────────────────────────────────────────────────────

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

    console.log(chalk.bold("\n📦  Installed versions:"));
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

// ─── Build Command ────────────────────────────────────────────────────────────

program
  .command("build")
  .description("Build a production-ready bundle of your docs")
  .action(async () => {
    const userDir = process.cwd();
    const BUILD_DIR = join(userDir, ".viabl");

    // Validate docs.json exists
    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\n  No docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your documentation folder\n"),
      );
      process.exit(1);
    }

    console.log(chalk.bold("\n📦  Viabl Build\n"));

    // ── Ensure renderer and content server are installed ──────────────────
    const rendererSpinner = ora("Checking renderer...").start();
    try {
      await ensureRenderer(rendererSpinner);
    } catch (err) {
      rendererSpinner.fail(chalk.red("Failed to install renderer"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    const serverSpinner = ora("Checking content server...").start();
    try {
      await ensureContentServer(serverSpinner);
    } catch (err) {
      serverSpinner.fail(chalk.red("Failed to install content server"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    // ── Assemble build output ─────────────────────────────────────────────
    const buildSpinner = ora("Assembling build output...").start();
    try {
      // Clean and recreate build dir
      if (existsSync(BUILD_DIR))
        rmSync(BUILD_DIR, { recursive: true, force: true });
      mkdirSync(BUILD_DIR, { recursive: true });

      // Copy renderer
      const { cpSync } = await import("fs");
      cpSync(RENDERER_DIR, join(BUILD_DIR, "renderer"), { recursive: true });

      // Copy content server
      cpSync(CONTENT_SERVER_DIR, join(BUILD_DIR, "content-server"), {
        recursive: true,
      });

      // Copy user's docs — copy individual items to avoid src/dest conflict
      // const { readdirSync } = await import("fs");
      const excluded = new Set([".git", "node_modules", ".viabl"]);
      const docsDir = join(BUILD_DIR, "docs");
      mkdirSync(docsDir, { recursive: true });

      for (const item of readdirSync(userDir)) {
        if (excluded.has(item)) continue;
        cpSync(join(userDir, item), join(docsDir, item), { recursive: true });
      }

      writeFileSync(join(BUILD_DIR, "start.js"), startScript, { mode: 0o755 });

      buildSpinner.succeed(chalk.dim("Build output ready"));
    } catch (err) {
      buildSpinner.fail(chalk.red("Build failed"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    }

    // ── Done ──────────────────────────────────────────────────────────────
    console.log(chalk.green("\n✔  Build complete\n"));
    console.log(chalk.white("  Output: ") + chalk.dim(".viabl/\n"));
    console.log(chalk.white("  To run locally:"));
    console.log(chalk.dim("    node .viabl/start.js\n"));
    console.log(chalk.dim("    PORT=<YOUR_PORT> node .viabl/start.js\n"));
  });

// ─── Start Command ────────────────────────────────────────────────────────────

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

    const child = spawn("node", [startJs], {
      env: { ...process.env, PORT: options.port },
      stdio: "inherit",
    });

    child.on("exit", (code) => process.exit(code ?? 0));

    const shutdown = () => {
      child.stderr?.removeAllListeners("data");
      child.stdout?.removeAllListeners("data");
      child.kill("SIGTERM");
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
