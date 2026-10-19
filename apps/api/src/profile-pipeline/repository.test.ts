import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractCheckout,
  fetchRepository,
  MAX_SAMPLED_FILES,
  sparseCheckoutPatterns,
} from "./repository.js";

let checkout: string | undefined;

afterEach(async () => {
  if (checkout) await rm(checkout, { recursive: true, force: true });
});

async function trackedCheckout(files: Record<string, string>): Promise<string> {
  checkout = await mkdtemp(path.join(tmpdir(), "talentradar-extract-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(checkout, file)), { recursive: true });
    await writeFile(path.join(checkout, file), content);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  return checkout;
}

describe("extractCheckout technology detection", () => {
  it("detects file-rule technologies even when the file was not sampled", async () => {
    const root = await trackedCheckout({
      Dockerfile: "# too large to read\n".repeat(20_000),
      "src/index.ts": "export const answer = 42;\n",
    });
    const result = await extractCheckout(root, {
      repoTokenBudget: 12_000,
      languages: { TypeScript: 100 },
    });

    expect(result.selectedFiles.map((file) => file.path)).not.toContain("Dockerfile");
    expect(result.technologyMatches.map((match) => match.id)).toContain("docker");
  });
});

describe("extractCheckout sampling", () => {
  const source = (lines: number) =>
    Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join(
      "\n",
    );

  it("selects 20 files by nonblank lines ahead of folder and byte size", async () => {
    const largest = source(1800);
    const root = await trackedCheckout({
      ...Object.fromEntries(
        Array.from({ length: 23 }, (_, index) => [
          `src/unit-${String(index).padStart(2, "0")}.ts`,
          source(80 + index),
        ]),
      ),
      "lib/largest.ts": largest,
      "src/padded.ts": `export const small = true;\n${"\n".repeat(4000)}`,
      "src/long-line.ts": `export const text = "${"x".repeat(60_000)}";`,
    });
    const result = await extractCheckout(root, { repoTokenBudget: 4000, languages: {} });
    expect(result.selectedFiles).toHaveLength(20);
    expect(result.selectedFiles[0]).toMatchObject({
      path: "lib/largest.ts",
      lineCount: 1800,
      truncated: true,
    });
    expect(result.selectedFiles.map((file) => file.path)).not.toContain("src/padded.ts");
    expect(result.selectedFiles.map((file) => file.path)).not.toContain("src/long-line.ts");
    expect(result.selectedFiles.map((file) => file.path)).not.toContain("src/unit-00.ts");
    expect(
      result.selectedFiles.reduce((sum, file) => sum + file.content.length, 0),
    ).toBeLessThanOrEqual(16_000);
    expect(result.selectedFiles.every((file) => file.content.length > 0)).toBe(true);
    const excerpt = result.selectedFiles[0]?.content ?? "";
    expect(excerpt).toContain("value0 = 0");
    expect(excerpt).toContain("value930 = 930");
    expect(excerpt).toContain("value1799 = 1799");
    expect(excerpt.match(/source omitted/g)).toHaveLength(2);
  });

  it("keeps small secondary languages, manifests, styling, delivery and infrastructure", async () => {
    const support = {
      "package.json": JSON.stringify({ dependencies: { react: "1", redis: "1", express: "1" } }),
      "scripts/analyze.py": "import numpy as np\nprint(np.mean([1, 2, 3]))\n",
      "web/styles.css": "body { color: red; }\n",
      Dockerfile: "FROM node:24\nCOPY . /app\n",
      ".github/workflows/ci.yml": "name: CI\non: push\njobs: {}\n",
      "infra/main.tf": 'resource "aws_s3_bucket" "uploads" {}\n',
    };
    const root = await trackedCheckout({
      ...Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`src/unit-${index}.ts`, source(200 + index)]),
      ),
      ...support,
    });
    const result = await extractCheckout(root, {
      repoTokenBudget: 4000,
      languages: { TypeScript: 1000, Python: 10 },
    });
    const sampled = new Map(result.selectedFiles.map((file) => [file.path, file]));
    expect(sampled.size).toBe(MAX_SAMPLED_FILES);
    for (const [file, content] of Object.entries(support)) {
      expect(sampled.get(file)).toMatchObject({ content, truncated: false });
    }
    expect(result.technologyMatches.map((match) => match.id)).toEqual(
      expect.arrayContaining([
        "react",
        "redis",
        "express",
        "python",
        "css",
        "docker",
        "github_actions",
        "terraform",
      ]),
    );
    expect(
      result.selectedFiles.reduce((sum, file) => sum + file.content.length, 0),
    ).toBeLessThanOrEqual(16_000);
  });

  it("redistributes unused shares, is deterministic and excludes unsafe files", async () => {
    const root = await trackedCheckout({
      "src/small.py": "print('hello')\n",
      "src/large.ts": source(2000),
      "src/generated.ts": source(3000),
      "src/binary.ts": "\0not source",
      "src/oversize.ts": "x".repeat(256 * 1024 + 1),
      "vendor/copied.ts": source(3000),
      "web/app.min.js": "var minified = true;",
    });
    await symlink(path.join(root, ".."), path.join(root, "src/outside.ts"));
    execFileSync("git", ["add", "."], { cwd: root });
    const options = { repoTokenBudget: 4000, languages: {} };
    const result = await extractCheckout(root, options);
    expect(result.selectedFiles.map((file) => file.path)).toEqual(["src/large.ts", "src/small.py"]);
    expect(result.selectedFiles[1]).toMatchObject({
      content: "print('hello')\n",
      lineCount: 1,
      truncated: false,
    });
    expect(result.selectedFiles[0]?.content.length).toBe(16_000 - "print('hello')\n".length);
    expect((await extractCheckout(root, options)).selectedFiles).toEqual(result.selectedFiles);
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
      "styles/site.css",
      "db/schema.sql",
      ".github/workflows/ci.yml",
      "infra/main.tf",
    ]);
    expect(patterns).toEqual([
      "/README.md",
      "/package.json",
      "/src/main.py",
      "/src/odd\\ \\[name\\].ts",
      "/styles/site.css",
      "/db/schema.sql",
      "/.github/workflows/ci.yml",
      "/infra/main.tf",
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
