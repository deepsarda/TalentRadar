import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export interface CommandResult {
  stdout: Buffer;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    env?: NodeJS.ProcessEnv;
    /** Written to stdin, then closed (e.g. a long path list that won't fit in argv). */
    input?: string;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Closing stdin right away (empty when there's no input) behaves like "ignore".
    child.stdin.end(options.input ?? "");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error(`${command} was cancelled`));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} exceeded ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      captured += chunk.length;
      if (captured > MAX_CAPTURE_BYTES) {
        child.kill("SIGTERM");
        finish(new Error(`${command} produced too much output`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) finish();
      else
        finish(
          new Error(
            `${command} failed (${signal ?? code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").slice(-1000)}`,
          ),
        );
    });
    options.signal?.addEventListener("abort", abort, { once: true });
  });
}
