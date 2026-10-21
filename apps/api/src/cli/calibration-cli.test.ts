import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CalibrationEntry,
  CalibrationSetSchema,
} from "../profile-pipeline/calibration/calibration.js";
import { buildResults } from "../profile-pipeline/calibration/report.js";
import { currentVersions } from "./calibration-files.js";
import { runCalibrationGate } from "./calibration-gate.js";
import { runCalibrationValidate } from "./calibration-validate.js";

/* Synthetic, test-only labels in a temp directory; the real calibration-set.json is untouched. */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "talentradar-calibration-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const entries: CalibrationEntry[] = Array.from({ length: 10 }, (_, index) => ({
  repository: `test-only/repo-${index}`,
  commitSha: index.toString(16).padStart(40, "a"),
  kind: index < 2 ? "genuine_novel" : index < 4 ? "looks_novel_but_not" : "ordinary",
  originality: { scorerA: 3, scorerB: 3 },
  skills: { react: { scorerA: 3, scorerB: 3 } },
}));

const write = (name: string, value: unknown) =>
  writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
const capture = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
};

async function writeResults(misses: number, patch: object = {}) {
  const set = CalibrationSetSchema.parse({ entries });
  const built = buildResults({
    set,
    versions: { model: "test-model", ...currentVersions },
    now: new Date("2026-10-21T00:00:00Z"),
    scored: entries.map((entry, index) => ({
      repository: entry.repository,
      judgedCommitSha: entry.commitSha,
      model: { originality: index < misses ? 5 : 3, skills: [{ id: "react", level: 3 }] },
    })),
  });
  await write("calibration-results.json", { ...built, ...patch });
}

const args = () => ["--set", path.join(dir, "set.json")];

describe("calibration:gate", () => {
  it("passes (pending) on an empty or partial set with no results file", async () => {
    await write("set.json", { entries: entries.slice(0, 4) });
    const out = capture();
    expect(await runCalibrationGate(args(), out.log)).toBe(0);
    expect(out.lines.join("\n")).toContain("PENDING - 4 of 10");
  });

  it("fails a complete set with no results file", async () => {
    await write("set.json", { entries });
    expect(await runCalibrationGate(args(), capture().log)).toBe(1);
  });

  it("passes at 8 of 10 and fails at 7 of 10", async () => {
    await write("set.json", { entries });
    await writeResults(2);
    const pass = capture();
    expect(await runCalibrationGate(args(), pass.log)).toBe(0);
    expect(pass.lines[0]).toContain("8 of 10");

    await writeResults(3);
    const fail = capture();
    expect(await runCalibrationGate(args(), fail.log)).toBe(1);
    expect(fail.lines[0]).toContain("7 of 10");
  });

  it("fails on results written under an older prompt version", async () => {
    await write("set.json", { entries });
    await writeResults(0, { versions: { model: "m", ...currentVersions, prompt: "v0-old" } });
    const out = capture();
    expect(await runCalibrationGate(args(), out.log)).toBe(1);
    expect(out.lines.join("\n")).toContain('prompt "v0-old"');
  });

  it("fails, rather than crashing, on invalid JSON", async () => {
    await write("set.json", "{ not json");
    const out = capture();
    expect(await runCalibrationGate(args(), out.log)).toBe(1);
    expect(out.lines[0]).toContain("not valid JSON");

    await write("set.json", { entries });
    await write("calibration-results.json", "{ nope");
    expect(await runCalibrationGate(args(), capture().log)).toBe(1);
  });

  it("fails when the set file is missing", async () => {
    expect(await runCalibrationGate(args(), capture().log)).toBe(1);
  });
});

describe("calibration:validate", () => {
  it("prints scorer agreement and exits 0 for a valid set", async () => {
    await write("set.json", { entries });
    const out = capture();
    expect(await runCalibrationValidate(args(), out.log)).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("10 entries, valid");
    expect(text).toContain("exact:        20/20 (100%)");
    expect(text).toContain("No judge results yet");
  });

  it("lists every problem with the repo it belongs to and exits 1", async () => {
    await write("set.json", {
      entries: [
        { ...entries[0], commitSha: "tooshort" },
        { ...entries[1], skills: { notaskill: { scorerA: 3, scorerB: 3 } } },
      ],
    });
    const out = capture();
    expect(await runCalibrationValidate(args(), out.log)).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toContain("test-only/repo-0");
    expect(text).toContain("test-only/repo-1");
    expect(text).toContain("Invalid: 2 error(s)");
  });

  it("shows judge-vs-human when fresh results exist, and explains when they are stale", async () => {
    await write("set.json", { entries });
    await writeResults(2);
    const fresh = capture();
    expect(await runCalibrationValidate(args(), fresh.log)).toBe(0);
    expect(fresh.lines.join("\n")).toContain("Within +-1 level on 8 of 10");
    expect(fresh.lines.join("\n")).toContain(
      "MISS  test-only/repo-0: originality (model 5 vs humans 3)",
    );

    await writeResults(0, { setDigest: "0".repeat(64) });
    const stale = capture();
    expect(await runCalibrationValidate(args(), stale.log)).toBe(0);
    expect(stale.lines.join("\n")).toContain("labels changed");
  });

  it("--strict turns warnings into a failing exit code", async () => {
    await write("set.json", { entries: entries.slice(0, 3) });
    expect(await runCalibrationValidate(args(), capture().log)).toBe(0);
    expect(await runCalibrationValidate([...args(), "--strict"], capture().log)).toBe(1);
  });
});

describe("calibrate --write-results file format", () => {
  it("round-trips through the gate", async () => {
    await write("set.json", { entries });
    await writeResults(0);
    const written = JSON.parse(await readFile(path.join(dir, "calibration-results.json"), "utf8"));
    expect(written.entries).toHaveLength(10);
    expect(written.versions).toMatchObject(currentVersions);
    expect(await runCalibrationGate(args(), capture().log)).toBe(0);
  });
});
