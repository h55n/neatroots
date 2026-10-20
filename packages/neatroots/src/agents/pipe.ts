import { spawn, type ChildProcess } from "node:child_process";

/**
 * Reads a CLI child's stdout as JSON lines and keeps the last 4,000 characters of stderr.
 * Both streams use the UTF-8 decoder, so a multibyte character split across pipe reads is
 * buffered instead of becoming U+FFFD (issue #616). Returns a getter for the stderr tail.
 */
export function pipeChild(child: ChildProcess, opts: { active: () => boolean; onEvent: (ev: Record<string, unknown>) => void }): () => string {
  let buf = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (!opts.active()) return;
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        opts.onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not an event line */
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  return () => stderr;
}

/**
 * Starts an agent CLI in its own process group. spawn() can throw before any child exists
 * (E2BIG on an oversized prompt), so a failure comes back as its message for the caller to end the turn.
 */
export function launchAgent(bin: string, args: string[], cwd: string, port: number): ChildProcess | string {
  try {
    return spawn(bin, args, { cwd, env: { ...process.env, NEATLOGS_ENDPOINT: `http://localhost:${port}` }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
