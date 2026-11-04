// Shared by the cross-language integration tests, which each generate a Go
// package, compile a handler against it, and drive the resulting server from a
// TypeScript client.

import { resolve } from "path";

const READY_PREFIX = "LISTENING ";

/** The module generated Go code imports its Socket.IO packages from. */
const SOCKETIO_MODULE = "github.com/nguyenvanduocit/socketrpc-gen/go/socketio";
const SOCKETIO_DIR = resolve(import.meta.dir, "..", "..", "go", "socketio");

/** Runs a command to completion and fails loudly with both streams on error. */
export function run(command: string[], cwd: string, label: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}):\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
}

/**
 * Points a fixture module, copied out of the repository, at the working tree's
 * `go/socketio`. The fixtures require the module without a `replace`, so the
 * path is attached here, where the copy's location is known: the tests then
 * exercise the Socket.IO code this checkout carries, not a published version.
 */
export function useLocalSocketio(goDir: string): void {
  run(["go", "mod", "edit", `-replace=${SOCKETIO_MODULE}=${SOCKETIO_DIR}`], goDir, "go mod edit -replace");
}

/**
 * Reads the server's stdout until it announces the address it bound. The Go
 * server listens on 127.0.0.1:0 and prints the resolved host:port once the
 * listener is accepting, so there is no fixed port to collide on and no polling
 * race between "spawned" and "reachable".
 */
export async function waitForAddress(proc: Bun.Subprocess, timeoutMs: number): Promise<string> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // Keep the trailing fragment: a half-received line must not be mistaken
      // for a complete address.
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(READY_PREFIX)) return line.slice(READY_PREFIX.length).trim();
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  throw new Error(`Go server did not report "${READY_PREFIX}" within ${timeoutMs}ms`);
}
