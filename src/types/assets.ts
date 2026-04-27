import { type Ora } from "ora";

export interface EnsureOptions {
  spinner: Ora;
  activeTempDirs: Set<string>;
  earlyAbortController: AbortController | null;
}
