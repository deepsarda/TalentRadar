import { describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";

describe("runCommand stdin", () => {
  it("survives a command that exits without reading its input (EPIPE)", async () => {
    // A command that exits immediately without reading stdin; 1 MB overflows pipe buffer.
    const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 10_000,
      input: "x".repeat(1 << 20),
    });
    expect(result.stderr).toBe("");
  });

  it("passes input through to a command that reads it", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      {
        timeoutMs: 10_000,
        input: "a\nb\n",
      },
    );
    expect(result.stdout.toString("utf8")).toBe("a\nb\n");
  });

  it("runs a command that takes no input", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log('ok')"], {
      timeoutMs: 10_000,
    });
    expect(result.stdout.toString("utf8").trim()).toBe("ok");
  });
});
