import { VERSION_FILE, HOME_DIR } from "./constants";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { VersionInfo } from "./types/version";

export function getVersionInfo(): VersionInfo {
  try {
    if (!existsSync(VERSION_FILE)) {
      return {
        renderer: null,
        rendererSrc: null,
        contentServer: null,
        lastBuiltBasePath: null,
        downloadedAt: "",
      };
    }
    return JSON.parse(readFileSync(VERSION_FILE, "utf-8")) as VersionInfo;
  } catch {
    return {
      renderer: null,
      rendererSrc: null,
      contentServer: null,
      lastBuiltBasePath: null,
      downloadedAt: "",
    };
  }
}

export function saveVersionInfo(info: Partial<VersionInfo>) {
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
