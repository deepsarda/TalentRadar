import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCheckout, fetchRepository, sparseCheckoutPatterns } from "./repository.js";

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

describe("sparseCheckoutPatterns", () => {
  it("fetches only what extraction reads, escaping glob characters", () => {
    const patterns = sparseCheckoutPatterns([
      "README.md",
      "package.json",
      "src/main.py",
      "data/images/street.jpg",
      "node_modules/x/index.js",
      "src/odd [name].ts",
    ]);
    expect(patterns).toEqual([
      "/README.md",
      "/package.json",
      "/src/main.py",
      "/src/odd\\ \\[name\\].ts",
    ]);
  });
});

describe("fetchRepository contributors", () => {
  it("accepts anonymous contributors (no login) instead of failing the whole repo", async () => {
    const fakeFetch = (async (url: string | URL) =>
      String(url).endsWith("/languages")
        ? Response.json({ JavaScript: 100 })
        : Response.json([
            { login: "someone-else", contributions: 10 },
            { login: null, type: "Anonymous", contributions: 1 },
          ])) as typeof fetch;

    // A fork with no commits by this user stops before cloning, so no network is needed.
    const result = await fetchRepository({
      repository: "riya/forked",
      login: "riya",
      pushedAt: "2026-10-01T00:00:00Z",
      fork: true,
      repoTokenBudget: 12_000,
      fetchImplementation: fakeFetch,
    });

    expect(result).toMatchObject({ included: false, exclusionReason: "fork_without_authorship" });
  });
});

describe("fileTree", () => {
  it("lists files up to four segments deep and collapses deeper ones into their folder", async () => {
    const { fileTree } = await import("./repository.js");
    expect(fileTree(["README.md", "a/b/c/d.kt", "a/b/c/d/e.kt", "a/b/c/d/f.kt", "x/y.py"])).toEqual(
      ["README.md", "a/b/c/d.kt", "a/b/c/d/", "x/y.py"],
    );
  });
});
