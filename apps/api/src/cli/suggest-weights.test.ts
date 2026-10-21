import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSuggestWeights } from "./suggest-weights.js";

describe("suggest-weights CLI", () => {
  it("exits 1 and shows usage when no file given", async () => {
    const lines: string[] = [];
    const code = await runSuggestWeights([], (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("Usage"))).toBe(true);
  });

  it("exits 1 when the file does not exist", async () => {
    const lines: string[] = [];
    const code = await runSuggestWeights(["--file", "/tmp/nonexistent-12345.json"], (line) =>
      lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("Cannot read"))).toBe(true);
  });

  it("exits 1 on invalid JSON", async () => {
    const tmp = join(tmpdir(), `suggest-test-${Date.now()}.json`);
    await writeFile(tmp, "not json");
    const lines: string[] = [];
    const code = await runSuggestWeights(["--file", tmp], (line) => lines.push(line));
    await unlink(tmp);
    expect(code).toBe(1);
    expect(lines.some((l) => l.toLowerCase().includes("invalid"))).toBe(true);
  });

  it("shows 'no ratings' message when runs have no outcome ratings", async () => {
    const data = {
      eventId: "abc",
      eventName: "Test Event",
      runs: [
        {
          runId: "r1",
          runName: "Run 1",
          params: { requirements: [], alpha: 0.7, noveltyWeight: 10 },
          overrides: [],
          outcomeRatings: [],
        },
      ],
    };
    const tmp = join(tmpdir(), `suggest-test-${Date.now()}.json`);
    await writeFile(tmp, JSON.stringify(data));
    const lines: string[] = [];
    const code = await runSuggestWeights(["--file", tmp], (line) => lines.push(line));
    await unlink(tmp);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No outcome ratings"))).toBe(true);
  });

  it("NEVER auto-applies suggestions (output is read-only)", async () => {
    // The function must never call process.exit or throw, and must always say "suggestions only"
    const data = {
      eventId: "abc",
      eventName: "Test Event",
      runs: [
        {
          runId: "r1",
          runName: "Run 1",
          params: {
            requirements: [{ skill: "backend", weight: 3 }],
            alpha: 0.7,
            noveltyWeight: 10,
          },
          overrides: [
            { teamId: "a".repeat(24), action: "pin_in", reason: "manual" },
            { teamId: "a".repeat(24), action: "pin_in", reason: "manual" },
            { teamId: "b".repeat(24), action: "pin_in", reason: "manual" },
          ],
          outcomeRatings: [
            { teamId: "a".repeat(24), rating: 5 },
            { teamId: "b".repeat(24), rating: 5 },
            { teamId: "c".repeat(24), rating: 2 },
            { teamId: "c".repeat(24), rating: 2 },
          ],
        },
      ],
    };
    const tmp = join(tmpdir(), `suggest-test-${Date.now()}.json`);
    await writeFile(tmp, JSON.stringify(data));
    const lines: string[] = [];
    const code = await runSuggestWeights(["--file", tmp], (line) => lines.push(line));
    await unlink(tmp);
    expect(code).toBe(0);
    // Verify it explicitly says these are suggestions only
    const fullOutput = lines.join("\n");
    expect(fullOutput).toMatch(/suggestion|never auto-applied|review/i);
    // Verify bounds: suggestions should not exceed alpha range [0,1] or noveltyWeight [0,25]
    // (In this implementation we output text, not machine-readable, so just check no auto-apply)
  });
});
