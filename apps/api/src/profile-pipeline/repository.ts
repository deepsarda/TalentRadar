import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTechnologies, type TechnologyMatch } from "@talentradar/shared";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { decryptSecret } from "../auth/crypto.js";
import type { PersonDocument, UserDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { githubFetch } from "../jobs/rate-limit.js";
import type { JobContext } from "../jobs/worker.js";
import { runCommand } from "./commands.js";
import { fetchCommitActivity, fetchUpstreamContributions } from "./github-signals.js";

const FetchRepositoryPayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  accessUserId: z.string().length(24).optional(),
  pushedAt: z.iso.datetime({ offset: true }).optional(),
  fork: z.boolean().default(false),
});

const GithubLanguagesSchema = z.record(z.string(), z.number().int().nonnegative());
// anon=1 includes commits whose email isn't linked to an account: they have no login but still
// count toward the total, so authorship isn't overstated.
const GithubContributorsSchema = z.array(
  z.object({ login: z.string().nullish(), contributions: z.number().int().nonnegative() }),
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
  token: string | undefined,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-github-api-version": "2026-03-10",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new Error(`GitHub returned ${response.status} for ${new URL(url).pathname}`);
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

async function readSafeFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<string | null> {
  const absolutePath = path.resolve(root, relativePath);
  const canonicalRoot = await realpath(root);
  // Paths outside the sparse checkout are tracked but have no file on disk.
  const canonicalPath = await realpath(absolutePath).catch(() => null);
  if (!canonicalPath) return null;
  if (!canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile() || fileStat.size > maxBytes) return null;
  const content = await readFile(canonicalPath);
  if (content.includes(0)) return null;
  return content.toString("utf8");
}

/**
 * The only paths extraction ever reads (manifests, a top-level README, source files). The clone
 * fetches just these, so image/data-heavy repos don't blow the clone timeout. Returned as
 * non-cone sparse-checkout patterns, anchored and with glob characters escaped.
 */
export function sparseCheckoutPatterns(trackedPaths: string[]): string[] {
  return trackedPaths
    .filter(
      (file) =>
        safePath(file) &&
        (manifestNames.has(path.basename(file).toLowerCase()) ||
          /^readme(?:\.[^/]+)?$/i.test(file) ||
          sourceExtensions.has(path.extname(file).toLowerCase())),
    )
    .map((file) => `/${file.replace(/[\\*?[\]!#\s]/g, "\\$&")}`);
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

/** How deep the file tree sent to the model goes, and how many entries at most. */
const TREE_DEPTH = 4;
const TREE_LIMIT = 400;

/**
 * Every tracked file up to TREE_DEPTH segments deep; deeper files collapse into their folder at
 * that depth, written with a trailing "/". The model may cite listed files (not folders).
 */
export function fileTree(files: string[]): string[] {
  const entries = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    entries.add(
      segments.length <= TREE_DEPTH ? file : `${segments.slice(0, TREE_DEPTH).join("/")}/`,
    );
    if (entries.size >= TREE_LIMIT) break;
  }
  return [...entries];
}

export interface ExtractedCheckout {
  commitSha: string;
  hasTests: boolean;
  hasCi: boolean;
  containerized: boolean;
  technologyMatches: TechnologyMatch[];
  tree: string[];
  readme?: string;
  readmePath?: string;
  selectedFiles: Array<{ path: string; content: string }>;
  /** Lower-cased paths of the manifests that were read for technology detection. */
  manifests: string[];
}

/**
 * Stage 2 of a repository fetch: reads facts and samples files from an existing checkout.
 * Changing what gets sampled here must bump `samplerVersion` in @talentradar/shared.
 */
export async function extractCheckout(
  checkout: string,
  options: {
    repoTokenBudget: number;
    languages: Record<string, number>;
    signal?: AbortSignal | undefined;
  },
): Promise<ExtractedCheckout> {
  const [shaResult, filesResult] = await Promise.all([
    runCommand("git", ["-C", checkout, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
      signal: options.signal,
    }),
    runCommand("git", ["-C", checkout, "ls-files", "-z"], {
      timeoutMs: 20_000,
      signal: options.signal,
    }),
  ]);
  const commitSha = shaResult.stdout.toString("utf8").trim();
  const files = filesResult.stdout
    .toString("utf8")
    .split("\0")
    .filter((file) => file && safePath(file));

  const manifests: Record<string, string> = {};
  for (const file of files) {
    if (!manifestNames.has(path.basename(file).toLowerCase())) continue;
    const content = await readSafeFile(checkout, file, 256 * 1024);
    if (content) manifests[file.toLowerCase()] = content;
  }
  const readmePath = files.find((file) => /^readme(?:\.[^/]+)?$/i.test(file));
  const readme = readmePath
    ? (await readSafeFile(checkout, readmePath, 256 * 1024))
        ?.split(/\r?\n/)
        .slice(0, 300)
        .join("\n")
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
  const technologyMatches = detectTechnologies({
    files: {
      // Every tracked path, empty, so file/path/extension rules (Dockerfile → docker, *.csproj…)
      // fire even when that file wasn't sampled. Real contents below override these on any
      // collision; content-based detectors only read manifests and sampled files.
      ...Object.fromEntries(files.map((file) => [file, ""])),
      ...manifests,
      ...Object.fromEntries(selectedFiles.map((file) => [file.path, file.content])),
    },
    languages: Object.keys(options.languages),
  });
  return {
    commitSha,
    hasTests: files.some((file) => /(^|\/)(__tests__|tests?|spec)(\/|\.)/i.test(file)),
    hasCi: files.some((file) => file.startsWith(".github/workflows/")),
    containerized: files.some((file) => /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i.test(file)),
    technologyMatches,
    tree: fileTree(files),
    ...(readme && readmePath ? { readme, readmePath } : {}),
    selectedFiles,
    manifests: Object.keys(manifests),
  };
}

export interface RepositoryHandlerOptions {
  db: Db;
  sessionSecret: string;
  repoTokenBudget: number;
  fetchImplementation?: typeof fetch;
}

export interface FetchRepositoryInput {
  repository: string;
  login: string;
  token?: string | undefined;
  pushedAt: string;
  fork: boolean;
  repoTokenBudget: number;
  signal?: AbortSignal | undefined;
  /** Defaults to the process-wide rate-limited GitHub fetch. */
  fetchImplementation?: typeof fetch;
  progress?: (code: string, message: string) => Promise<void>;
}

/** Reads GitHub facts, clones and extracts one repository: the fetch_repo job without the Db. */
export async function fetchRepository(
  input: FetchRepositoryInput,
): Promise<Record<string, unknown>> {
  const fetchImplementation = input.fetchImplementation ?? githubFetch;
  const progress = input.progress ?? (async () => {});
  const signal = input.signal;
  const encodedRepository = input.repository.split("/").map(encodeURIComponent).join("/");

  await progress("repo.metadata.started", `Reading GitHub facts for ${input.repository}`);
  const [languagePayload, contributorPayload] = await Promise.all([
    githubJson(
      `https://api.github.com/repos/${encodedRepository}/languages`,
      input.token,
      fetchImplementation,
      signal,
    ),
    githubJson(
      `https://api.github.com/repos/${encodedRepository}/contributors?per_page=100&anon=1`,
      input.token,
      fetchImplementation,
      signal,
    ),
  ]);
  const languages = GithubLanguagesSchema.parse(languagePayload);
  const contributors = GithubContributorsSchema.parse(contributorPayload);
  const totalContributions = contributors.reduce(
    (sum, contributor) => sum + contributor.contributions,
    0,
  );
  const ownContributions =
    contributors.find(
      (contributor) => contributor.login?.toLowerCase() === input.login.toLowerCase(),
    )?.contributions ?? 0;
  const authorship = totalContributions > 0 ? ownContributions / totalContributions : 0;
  if (input.fork && ownContributions === 0) {
    await progress(
      "repo.skipped",
      `${input.repository} is a fork with no commits by ${input.login}`,
    );
    return {
      repository: input.repository,
      included: false,
      exclusionReason: "fork_without_authorship",
    };
  }

  // Deterministic signals for the judge and the aggregation; each is best-effort.
  const [commitActivity, upstream] = await Promise.all([
    fetchCommitActivity(input.repository, input.login, input.token, fetchImplementation, signal),
    fetchUpstreamContributions(input.login, input.token, fetchImplementation, signal),
  ]);

  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "talentradar-repo-"));
  const checkout = path.join(temporaryRoot, "checkout");
  try {
    await progress("repo.clone.started", `Cloning ${input.repository} at depth 1`);
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
        // Trees only: blobs are fetched below for just the files extraction reads.
        "--filter=blob:none",
        "--no-checkout",
        `https://github.com/${input.repository}.git`,
        checkout,
      ],
      { timeoutMs: 120_000, signal, env: gitEnv },
    );
    const tracked = await runCommand(
      "git",
      ["-C", checkout, "ls-tree", "-r", "-z", "--name-only", "HEAD"],
      {
        timeoutMs: 20_000,
        signal,
      },
    );
    const patterns = sparseCheckoutPatterns(
      tracked.stdout.toString("utf8").split("\0").filter(Boolean),
    );
    await runCommand("git", ["-C", checkout, "sparse-checkout", "set", "--no-cone", "--stdin"], {
      timeoutMs: 20_000,
      signal,
      env: gitEnv,
      input: `${patterns.join("\n")}\n`,
    });
    await runCommand(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.file.allow=never",
        "-C",
        checkout,
        "checkout",
      ],
      { timeoutMs: 120_000, signal, env: gitEnv },
    );
    const extracted = await extractCheckout(checkout, {
      repoTokenBudget: input.repoTokenBudget,
      languages,
      signal,
    });
    await progress(
      "repo.clone.completed",
      `Cloned ${input.repository} at ${extracted.commitSha.slice(0, 12)}`,
    );
    await progress(
      "repo.extract.completed",
      `${input.repository}: ${extracted.technologyMatches.length} technology hints, tests ${extracted.hasTests ? "found" : "not found"}, CI ${extracted.hasCi ? "found" : "not found"}`,
    );
    const { manifests: _manifests, ...facts } = extracted;
    return {
      repository: input.repository,
      included: true,
      pushedAt: input.pushedAt,
      authorship,
      languages,
      ...(commitActivity ? { commitActivity } : {}),
      ...(upstream ? { participant: upstream } : {}),
      ...facts,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function createFetchRepositoryHandler(options: RepositoryHandlerOptions) {
  return async ({ job, progress, signal }: JobContext): Promise<Record<string, unknown>> => {
    const payload = FetchRepositoryPayloadSchema.parse(job.payload);
    if (!payload.pushedAt) throw new Error(`${payload.repository} has no GitHub push timestamp`);
    const person = await options.db
      .collection<PersonDocument>(collections.people)
      .findOne({ _id: ObjectId.createFromHexString(payload.personId) });
    if (!person) throw new Error("Repository job person no longer exists");
    const accessUserId =
      person.userId ??
      (payload.accessUserId ? ObjectId.createFromHexString(payload.accessUserId) : undefined);
    const accessUser = accessUserId
      ? await options.db.collection<UserDocument>(collections.users).findOne({ _id: accessUserId })
      : null;
    const token = accessUser
      ? decryptSecret(accessUser.encryptedAccessToken, options.sessionSecret)
      : undefined;
    return fetchRepository({
      repository: payload.repository,
      login: person.github,
      token,
      pushedAt: payload.pushedAt,
      fork: payload.fork,
      repoTokenBudget: options.repoTokenBudget,
      signal,
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
      progress,
    });
  };
}
