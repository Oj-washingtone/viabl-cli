import { join } from "path";
import { homedir } from "os";

export const RELEASES_REPO = "Oj-washingtone/viabl-releases";
export const HOME_DIR = join(homedir(), ".viabl");
export const RENDERER_DIR = join(HOME_DIR, "renderer");
export const RENDERER_SRC_DIR = join(HOME_DIR, "renderer-src");
export const CONTENT_SERVER_DIR = join(HOME_DIR, "content-server");
export const VERSION_FILE = join(HOME_DIR, "version.json");
export const STARTER_REPO = "Oj-washingtone/viabl-starter";
