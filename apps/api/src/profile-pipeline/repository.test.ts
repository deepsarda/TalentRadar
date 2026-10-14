import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCheckout } from "./repository.js";

let checkout: string | undefined;

afterEach(async () => {
  if (checkout) await rm(checkout, { recursive: true, force: true });
});

describe("extractCheckout technology detection", () => {
  it("detects file-rule technologies even when the file was not sampled", async () => {
    checkout = await mkdtemp(path.join(tmpdir(), "talentradar-extract-"));
    await mkdir(path.join(checkout, "src"));
    await writeFile(path.join(checkout, "Dockerfile"), "FROM node:24\n");
    await writeFile(path.join(checkout, "src", "index.ts"), "export const answer = 42;\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: checkout, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");

    const result = await extractCheckout(checkout, {
      repoTokenBudget: 12_000,
      languages: { TypeScript: 100 },
    });

    expect(result.selectedFiles.map((file) => file.path)).not.toContain("Dockerfile");
    expect(result.technologyMatches.map((match) => match.id)).toContain("docker");
  });
});
