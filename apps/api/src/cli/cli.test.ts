import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDetectReport } from "./detect-report.js";
import { runProfileCli } from "./profile.js";

let checkout: string;

/** A tiny git checkout: a React app, a Go module (no parser yet) and one sampled source file. */
beforeAll(async () => {
  checkout = await mkdtemp(path.join(tmpdir(), "talentradar-cli-test-"));
  await mkdir(path.join(checkout, "src"));
  await mkdir(path.join(checkout, "tools"));
  await writeFile(
    path.join(checkout, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", "left-pad": "1.3.0" } }),
  );
  await writeFile(path.join(checkout, "tools/go.mod"), "module example.com/tools\n\ngo 1.24\n");
  await writeFile(path.join(checkout, "README.md"), "# Tiny\n");
  const component = Array.from(
    { length: 40 },
    (_, index) => `export const Item${index} = () => <li>item ${index}</li>;`,
  ).join("\n");
  await writeFile(path.join(checkout, "src/App.tsx"), `import React from "react";\n${component}\n`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd: checkout,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
});

afterAll(() => rm(checkout, { recursive: true, force: true }));

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("pnpm profile", () => {
  it("--dry-run on a local checkout prints facts and sampled files without any credentials", async () => {
    const out = capture();
    expect(await runProfileCli(["--dry-run", checkout], {}, out.log)).toBe(0);
    expect(out.text()).toContain("src/App.tsx");
    expect(out.text()).toMatch(/react\s+npm:react/);
    expect(out.text()).toContain("readme      README.md");
    expect(out.text()).toContain("stopped before the model call");
  });

  it("refuses a full run on a local checkout", async () => {
    const out = capture();
    expect(await runProfileCli([checkout], {}, out.log)).toBe(2);
  });

  it("stops before any network call when GEMINI_API_KEY is missing (GITHUB_TOKEN is optional)", async () => {
    const out = capture();
    expect(await runProfileCli(["octo-student"], {}, out.log)).toBe(1);
    expect(out.text()).toContain("GEMINI_API_KEY");
    expect(out.text()).not.toContain("Missing GITHUB_TOKEN");
  });
});

describe("pnpm detect-report", () => {
  it("prints matches with reasons and the manifests that matched nothing", async () => {
    const out = capture();
    expect(await runDetectReport([checkout, "--languages", "TypeScript"], {}, out.log)).toBe(0);
    const text = out.text();
    expect(text).toMatch(/react\s+npm:react/);
    expect(text).toMatch(/typescript\s+.*language:TypeScript/);
    expect(text).toContain("Unmatched manifests (1): tools/go.mod");
  });

  it("explains a directory that is not a git checkout", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "talentradar-cli-plain-"));
    const out = capture();
    try {
      expect(await runDetectReport([plain], {}, out.log)).toBe(1);
      expect(out.text()).toContain("git checkout");
    } finally {
      await rm(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
