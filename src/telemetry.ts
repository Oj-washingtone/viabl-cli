import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import {
  HOME_DIR,
  TELEMETRY_FILE,
  TELEMETRY_URL,
  CLI_VERSION,
} from "./constants";

export type TelemetryEvent =
  | "init"
  | "dev"
  | "build"
  | "start"
  | "update"
  | "clear_cache";

export type ErrorType =
  | "download_failed"
  | "port_in_use"
  | "docs_json_missing"
  | "renderer_missing"
  | "content_server_missing"
  | "content_server_timeout"
  | "failed_render_build"
  | "git_failed"
  | "npm_ci_failed"
  | "unknown";

interface TelemetryConfig {
  sessionId: string;
  enabled: boolean;
  notifiedAt: string;
}

interface EventPayload {
  event: TelemetryEvent;
  session_id: string;
  cli_version: string;
  node_version: string;
  platform: string;
  arch: string;
  ci: boolean;
  duration?: number;
  success: boolean;
  error_type?: ErrorType;
  timestamp: string;
}

function getTelemetryConfig(): TelemetryConfig | null {
  try {
    if (!existsSync(TELEMETRY_FILE)) return null;
    return JSON.parse(readFileSync(TELEMETRY_FILE, "utf-8")) as TelemetryConfig;
  } catch {
    return null;
  }
}

function saveTelemetryConfig(config: TelemetryConfig): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TELEMETRY_FILE, JSON.stringify(config, null, 2));
  } catch {}
}

export function isFirstRun(): boolean {
  return getTelemetryConfig() === null;
}

export function initTelemetry(): void {
  if (getTelemetryConfig() !== null) return;
  saveTelemetryConfig({
    sessionId: randomUUID(),
    enabled: true,
    notifiedAt: new Date().toISOString(),
  });
}

export function isTelemetryEnabled(): boolean {
  const config = getTelemetryConfig();
  if (!config) return true; // default enabled before first init
  return config.enabled;
}

export function setTelemetryEnabled(enabled: boolean): void {
  const config = getTelemetryConfig();
  saveTelemetryConfig({
    sessionId: config?.sessionId ?? randomUUID(),
    enabled,
    notifiedAt: config?.notifiedAt ?? new Date().toISOString(),
  });
}

export function track(
  event: TelemetryEvent,
  opts: {
    success: boolean;
    duration?: number;
    errorType?: ErrorType;
  },
): void {
  if (!isTelemetryEnabled()) return;

  const config = getTelemetryConfig();
  if (!config) return;

  const payload: EventPayload = {
    event,
    session_id: config.sessionId,
    cli_version: CLI_VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: isCI(),
    success: opts.success,
    duration: opts.duration,
    error_type: opts.errorType,
    timestamp: new Date().toISOString(),
  };

  // Fire and forget — never await, never block
  sendEvent(payload).catch(() => {});
}

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS
  );
}

async function sendEvent(payload: EventPayload): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Silently ignore all errors — telemetry must never affect the CLI
  } finally {
    clearTimeout(timeout);
  }
}
