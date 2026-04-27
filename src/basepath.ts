import { readFileSync } from "fs";
import { join } from "path";

export function getDocsBasePath(userDir: string): string {
  try {
    const configPath = join(userDir, "docs.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.basePath ?? "";
  } catch {
    return "";
  }
}
