#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { ChildProcess } from "child_process";
import spawn from "cross-spawn";

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { startScript } from "./startScript";
import { prompt } from "./utils/prompt";
import { gitInit, gitCommit } from "./utils/gitHelpers";

import { HOME_DIR, RENDERER_DIR, CONTENT_SERVER_DIR } from "./constants";
import { findAvailablePort } from "./managePorts";
import { getVersionInfo } from "./version";
import { registerEarlyShutdown } from "./utils/shutdowns";
import { waitForServer } from "./server";
import { runSteps } from "./utils/ensureSteps";
import { buildRenderer } from "./render";
import { downloadStarter } from "./assets";

const { version } = require("../package.json");

export const activeTempDirs = new Set<string>();
export let earlyAbortController: AbortController | null = new AbortController();
let activeSpinner: Ora | null = null;

program
  .name("viabl")
  .description("Viabl documentation renderer CLI")
  .version(version);

// Init Command

program
  .command("init [project-name]")
  .description("Create a new Viabl documentation project")
  .action(async (projectName?: string) => {
    registerEarlyShutdown({
      earlyAbortController,
      activeTempDirs,
      activeSpinner,
    });

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
      await downloadStarter({
        destDir: projectDir,
        onProgress: (msg) => {
          spinner.text = msg;
        },
        activeTempDirs,
        earlyAbortController,
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
    const earlyShutdownHandler = registerEarlyShutdown({
      earlyAbortController,
      activeTempDirs,
      activeSpinner,
    });

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

    const ensured = await runSteps(
      { renderer: true, rendererSources: false, contentServer: true },
      { activeTempDirs, earlyAbortController },
    );

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
      await waitForServer(contentPort, 20000);
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
    registerEarlyShutdown({
      earlyAbortController,
      activeTempDirs,
      activeSpinner,
    });

    console.log(chalk.bold("\nChecking for updates...\n"));

    const ensured = await runSteps(
      { renderer: true, rendererSources: false, contentServer: true },
      { activeTempDirs, earlyAbortController },
    );
    if (!ensured) process.exit(1);

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

    registerEarlyShutdown({
      earlyAbortController,
      activeTempDirs,
      activeSpinner,
    });

    if (!existsSync(join(userDir, "docs.json"))) {
      console.error(chalk.red("\n  No docs.json found in current directory"));
      console.error(
        chalk.dim("    Make sure you are inside your documentation folder\n"),
      );
      process.exit(1);
    }

    console.log(chalk.bold("\n📦  Viabl Build\n"));

    // dev uses renderer, build uses rendererSources
    const ensured = await runSteps(
      {
        renderer: false,
        rendererSources: true,
        contentServer: true,
      },
      { activeTempDirs, earlyAbortController },
    );
    if (!ensured) process.exit(1);

    if (existsSync(BUILD_DIR))
      rmSync(BUILD_DIR, { recursive: true, force: true });
    mkdirSync(BUILD_DIR, { recursive: true });

    // Build renderer with user's basePath
    const buildSpinner = ora("Building renderer...").start();
    activeSpinner = buildSpinner;
    try {
      await buildRenderer(userDir, buildSpinner);
    } catch (err) {
      buildSpinner.fail(chalk.red("Renderer build failed"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    } finally {
      activeSpinner = null;
    }

    // Assemble .viabl/ output
    const assembleSpinner = ora("Assembling build output...").start();
    activeSpinner = assembleSpinner;
    try {
      mkdirSync(BUILD_DIR, { recursive: true });

      const { cp } = await import("fs/promises");

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
      assembleSpinner.succeed(chalk.dim("Build output ready"));
    } catch (err) {
      assembleSpinner.fail(chalk.red("Failed to assemble build"));
      console.error(err instanceof Error ? chalk.dim(err.message) : err);
      process.exit(1);
    } finally {
      activeSpinner = null;
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
