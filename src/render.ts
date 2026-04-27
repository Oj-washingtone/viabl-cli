import chalk from "chalk";
import { type Ora } from "ora";
import spawn from "cross-spawn";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`npm install failed (exit code ${code}): ${stderr}`),
          ),
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

  const standaloneDir = join(RENDERER_SRC_DIR, ".next", "standalone");

  // Skip rebuild if nothing changed

  const projectRendererDir = join(userDir, ".viabl", "renderer");

  const metaFile = join(projectRendererDir, ".viabl-meta.json");
  let lastBuiltBasePath: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    lastBuiltBasePath = meta.basePath ?? null;
  } catch {}

  if (lastBuiltBasePath === basePath && existsSync(projectRendererDir)) {
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

  spinner.text = "Copying build output...";
  await cp(standaloneDir, projectRendererDir, {
    recursive: true,
    dereference: true,
    force: true,
  });

  writeFileSync(metaFile, JSON.stringify({ basePath }), "utf-8");
  spinner.succeed(chalk.dim("Renderer built successfully"));
}
