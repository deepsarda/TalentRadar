import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTechnologies } from "@talentradar/shared";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { decryptSecret } from "../auth/crypto.js";
import { collections } from "../database/mongo.js";
import type { PersonDocument, UserDocument } from "../database/models.js";
import type { JobContext } from "../jobs/worker.js";
import { runCommand } from "./commands.js";

const FetchRepositoryPayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pushedAt: z.iso.datetime({ offset: true }).optional(),
  fork: z.boolean().default(false),
});

const GithubLanguagesSchema = z.record(z.string(), z.number().int().nonnegative());
const GithubContributorsSchema = z.array(
  z.object({ login: z.string(), contributions: z.number().int().nonnegative() }),
);

const manifestNames = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
  "composer.json",
  "gemfile",
  "pom.xml",
  "dockerfile",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".dart",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cs",
  ".rb",
  ".php",
  ".sol",
  ".vue",
  ".svelte",
]);
const excludedSegments = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "vendor",
  "coverage",
  "target",
  ".git",
]);

async function githubJson(
  url: string,
  token: string,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

function safePath(filePath: string): boolean {
  const segments = filePath.toLowerCase().split("/");
  return (
    !segments.some((segment) => excludedSegments.has(segment)) &&
    !filePath.endsWith(".min.js") &&
    !filePath.endsWith(".lock") &&
    !filePath.endsWith(".ipynb") &&
    !filePath.includes("generated")
  );
}

async function readSafeFile(root: string, relativePath: string, maxBytes: number): Promise<string | null> {
  const absolutePath = path.resolve(root, relativePath);
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(absolutePath);
  if (!canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile() || fileStat.size > maxBytes) return null;
  const content = await readFile(canonicalPath);
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

function sourceScore(filePath: string): number {
  const normalized = filePath.toLowerCase();
  let score = 0;
  if (normalized.startsWith("src/") || normalized.includes("/src/")) score += 6;
  if (normalized.startsWith("app/") || normalized.includes("/app/")) score += 4;
  if (/(test|spec)\./.test(normalized)) score -= 2;
  score -= normalized.split("/").length * 0.1;
  return score;
}

function twoLevelTree(files: string[]): string[] {
  return files
    .map((file) => file.split("/").slice(0, 3).join("/"))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 500);
}

export interface RepositoryHandlerOptions {
  db: Db;
  sessionSecret: string;
  repoTokenBudget: number;
  fetchImplementation?: typeof fetch;
}

export function createFetchRepositoryHandler(options: RepositoryHandlerOptions) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async ({ job, progress, signal }: JobContext): Promise<Record<string, unknown>> => {
    const payload = FetchRepositoryPayloadSchema.parse(job.payload);
    if (!payload.pushedAt) throw new Error(`${payload.repository} has no GitHub push timestamp`);
    const person = await options.db
      .collection<PersonDocument>(collections.people)
      .findOne({ _id: ObjectId.createFromHexString(payload.personId) });
    if (!person?.userId) throw new Error("Repository job requires a verified GitHub person");
    const user = await options.db
      .collection<UserDocument>(collections.users)
      .findOne({ _id: person.userId });
    if (!user) throw new Error("GitHub account no longer exists");
    const token = decryptSecret(user.encryptedAccessToken, options.sessionSecret);
    const encodedRepository = payload.repository.split("/").map(encodeURIComponent).join("/");

    await progress("repo.metadata.started", `Reading GitHub facts for ${payload.repository}`);
    const [languagePayload, contributorPayload] = await Promise.all([
      githubJson(
        `https://api.github.com/repos/${encodedRepository}/languages`,
        token,
        fetchImplementation,
      ),
      githubJson(
        `https://api.github.com/repos/${encodedRepository}/contributors?per_page=100&anon=1`,
        token,
        fetchImplementation,
      ),
    ]);
    const languages = GithubLanguagesSchema.parse(languagePayload);
    const contributors = GithubContributorsSchema.parse(contributorPayload);
    const totalContributions = contributors.reduce((sum, contributor) => sum + contributor.contributions, 0);
    const ownContributions =
      contributors.find((contributor) => contributor.login.toLowerCase() === user.login.toLowerCase())
        ?.contributions ?? 0;
    const authorship = totalContributions > 0 ? ownContributions / totalContributions : 0;
    if (payload.fork && ownContributions === 0) {
      await progress("repo.skipped", `${payload.repository} is a fork with no commits by ${user.login}`);
      return { repository: payload.repository, included: false, exclusionReason: "fork_without_authorship" };
    }

    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "talentradar-repo-"));
    const checkout = path.join(temporaryRoot, "checkout");
    try {
      await progress("repo.clone.started", `Cloning ${payload.repository} at depth 1`);
      await runCommand(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.file.allow=never",
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          `https://github.com/${payload.repository}.git`,
          checkout,
        ],
        {
          timeoutMs: 120_000,
          signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        },
      );
      const [shaResult, filesResult] = await Promise.all([
        runCommand("git", ["-C", checkout, "rev-parse", "HEAD"], { timeoutMs: 10_000, signal }),
        runCommand("git", ["-C", checkout, "ls-files", "-z"], { timeoutMs: 20_000, signal }),
      ]);
      const commitSha = shaResult.stdout.toString("utf8").trim();
      const files = filesResult.stdout
        .toString("utf8")
        .split("\0")
        .filter((file) => file && safePath(file));
      await progress("repo.clone.completed", `Cloned ${payload.repository} at ${commitSha.slice(0, 12)}`);

      const manifests: Record<string, string> = {};
      for (const file of files) {
        if (!manifestNames.has(path.basename(file).toLowerCase())) continue;
        const content = await readSafeFile(checkout, file, 256 * 1024);
        if (content) manifests[file.toLowerCase()] = content;
      }
      const readmePath = files.find((file) => /^readme(?:\.[^/]+)?$/i.test(file));
      const readme = readmePath
        ? (await readSafeFile(checkout, readmePath, 256 * 1024))?.split(/\r?\n/).slice(0, 300).join("\n")
        : undefined;
      const sourceCandidates = files
        .filter((file) => sourceExtensions.has(path.extname(file).toLowerCase()))
        .sort((left, right) => sourceScore(right) - sourceScore(left) || left.localeCompare(right));
      const selectedFiles: Array<{ path: string; content: string }> = [];
      let remainingCharacters = options.repoTokenBudget * 4;
      for (const file of sourceCandidates) {
        if (selectedFiles.length >= 8 || remainingCharacters <= 0) break;
        const content = await readSafeFile(checkout, file, 40 * 1024);
        if (!content || Buffer.byteLength(content) < 1024) continue;
        const included = content.slice(0, remainingCharacters);
        selectedFiles.push({ path: file, content: included });
        remainingCharacters -= included.length;
      }
      const detectorFiles = {
        ...manifests,
        ...Object.fromEntries(selectedFiles.map((file) => [file.path, file.content])),
      };
      const technologyMatches = detectTechnologies({
        files: detectorFiles,
        languages: Object.keys(languages),
      });
      const hasTests = files.some((file) => /(^|\/)(__tests__|tests?|spec)(\/|\.)/i.test(file));
      const hasCi = files.some((file) => file.startsWith(".github/workflows/"));
      const containerized = files.some((file) => /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i.test(file));
      await progress(
        "repo.extract.completed",
        `${payload.repository}: ${technologyMatches.length} technology hints, tests ${hasTests ? "found" : "not found"}, CI ${hasCi ? "found" : "not found"}`,
      );

      return {
        repository: payload.repository,
        included: true,
        commitSha,
        pushedAt: payload.pushedAt,
        authorship,
        languages,
        hasTests,
        hasCi,
        containerized,
        technologyMatches,
        tree: twoLevelTree(files),
        ...(readme ? { readme, readmePath } : {}),
        selectedFiles,
      };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };
}
