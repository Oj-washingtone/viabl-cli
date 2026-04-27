import chalk from "chalk";
import { type Ora } from "ora";
import spawn from "cross-spawn";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { downloadAndExtract, getLatestAsset } from "./assets";
import { getVersionInfo, saveVersionInfo } from "./version";
import { withRetry } from "./utils/retry";
import { RENDERER_SRC_DIR, RENDERER_DIR } from "./constants";
import { getDocsBasePath } from "./basepath";
import { type EnsureOptions } from "./types/assets";

export async function ensureRendererSources(
  options: EnsureOptions,
): Promise<void> {
  const { spinner, activeTempDirs, earlyAbortController } = options;
  const { rendererSrc: installedVersion } = getVersionInfo();

  spinner.text = "Checking renderer sources...";

  const { version, downloadUrl } = await withRetry(
    () => getLatestAsset("renderer-sources.tar.gz"),
    3,
    1500,
    earlyAbortController ?? undefined,
  );

  if (installedVersion === version && existsSync(RENDERER_SRC_DIR)) {
    spinner.succeed(chalk.dim(`Renderer sources ${version} ready`));
    return;
  }

  spinner.text = installedVersion
    ? `Updating renderer sources ${installedVersion} → ${version}...`
    : `Installing renderer sources ${version}...`;

  await downloadAndExtract({
    downloadUrl,
    destDir: RENDERER_SRC_DIR,
    label: "renderer sources",
    activeTempDirs,
    earlyAbortController,
    onProgress: (msg) => {
      spinner.text = msg;
    },
  });

  spinner.text = "Installing renderer dependencies...";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: RENDERER_SRC_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("npm install failed")),
    );
  });

  saveVersionInfo({ rendererSrc: version });
  spinner.succeed(chalk.dim(`Renderer sources ${version} installed`));
}

export async function ensureRenderer(options: EnsureOptions): Promise<void> {
  const { spinner, activeTempDirs, earlyAbortController } = options;
  const { renderer: installedVersion } = getVersionInfo();

  spinner.text = "Checking renderer...";

  const { version, downloadUrl } = await withRetry(
    () => getLatestAsset("renderer-standalone.tar.gz"),
    3,
    1500,
    earlyAbortController ?? undefined,
  );

  if (installedVersion === version && existsSync(RENDERER_DIR)) {
    spinner.succeed(chalk.dim(`Renderer ${version} ready`));
    return;
  }

  spinner.text = installedVersion
    ? `Updating renderer ${installedVersion} → ${version}...`
    : `Installing renderer ${version}...`;

  await downloadAndExtract({
    downloadUrl,
    destDir: RENDERER_DIR,
    label: "renderer",
    activeTempDirs,
    earlyAbortController,
    onProgress: (msg) => {
      spinner.text = msg;
    },
  });

  saveVersionInfo({ renderer: version });
  spinner.succeed(chalk.dim(`Renderer ${version} installed`));
}

export async function buildRenderer(
  userDir: string,
  spinner: Ora,
): Promise<void> {
  const basePath = getDocsBasePath(userDir);
  const { lastBuiltBasePath } = getVersionInfo();

  // Skip rebuild if nothing changed
  const standaloneDir = join(RENDERER_SRC_DIR, ".next", "standalone");
  if (lastBuiltBasePath === basePath && existsSync(standaloneDir)) {
    spinner.succeed(chalk.dim("Renderer already built for this basePath"));
    return;
  }

  spinner.text = `Building renderer${basePath ? ` for basePath: ${basePath}` : ""}...`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], {
      cwd: RENDERER_SRC_DIR,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_BASE_PATH: basePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("next build failed")),
    );
  });

  // Copy static assets into standalone
  const { cp } = await import("fs/promises");
  const staticSrc = join(RENDERER_SRC_DIR, ".next", "static");
  const staticDest = join(
    RENDERER_SRC_DIR,
    ".next",
    "standalone",
    ".next",
    "static",
  );
  const publicSrc = join(RENDERER_SRC_DIR, "public");
  const publicDest = join(RENDERER_SRC_DIR, ".next", "standalone", "public");

  await cp(staticSrc, staticDest, { recursive: true, force: true });
  if (existsSync(publicSrc)) {
    await cp(publicSrc, publicDest, { recursive: true, force: true });
  }

  // Replace cached prebuilt renderer with freshly built one
  spinner.text = "Copying build output...";
  if (existsSync(RENDERER_DIR)) {
    rmSync(RENDERER_DIR, { recursive: true, force: true });
  }
  await cp(standaloneDir, RENDERER_DIR, { recursive: true, dereference: true });

  saveVersionInfo({ lastBuiltBasePath: basePath });
  spinner.succeed(chalk.dim(`Renderer built successfully`));
}
