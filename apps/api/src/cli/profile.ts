import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readEnvironment } from "../config/environment.js";
import { RetryLaterError } from "../jobs/rate-limit.js";
import {
  collectRepositories,
  judgeAndAggregate,
  type Log,
  prepareCv,
} from "../profile-pipeline/local-run.js";
import { extractCheckout } from "../profile-pipeline/repository.js";
import { formatFacts, formatProfile, formatSkipped } from "./format.js";

const usage = `Usage: pnpm profile <github-login> [--cv <synthetic-cv.pdf>]
       pnpm profile --dry-run <github-login | path-to-local-checkout>

Runs fetch -> extract -> judge -> aggregate for one person and prints the profile with evidence.
--dry-run stops after extraction (no model call) and prints the facts and sampled files.
Needs GITHUB_TOKEN for a login, and GEMINI_API_KEY unless --dry-run. Free-tier Gemini: synthetic CVs only.`;

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

async function isDirectory(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** The CLI body, injectable for tests. Returns the process exit code. */
export async function runProfileCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  log: Log,
  cwd = process.cwd(),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      cv: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const target = positionals[0];
  if (values.help || !target || positionals.length > 1) {
    log(usage);
    return values.help ? 0 : 2;
  }
  const dryRun = values["dry-run"];
  const environment = readEnvironment(env);
  const localPath = path.resolve(cwd, target);

  if (await isDirectory(localPath)) {
    if (!dryRun) {
      log("A local checkout can only be inspected with --dry-run (it has no GitHub authorship).");
      return 2;
    }
    const extracted = await extractCheckout(localPath, {
      repoTokenBudget: environment.REPO_TOKEN_BUDGET,
      languages: {},
    });
    const { manifests, ...facts } = extracted;
    log(formatFacts({ repository: path.basename(localPath), languages: {}, ...facts }).join("\n"));
    log(`  manifests read: ${manifests.length > 0 ? manifests.join(", ") : "(none)"}`);
    log("\nDry run: stopped before the model call.");
    return 0;
  }

  if (!LOGIN_PATTERN.test(target)) {
    log(`"${target}" is neither a GitHub login nor an existing directory.\n\n${usage}`);
    return 2;
  }
  const githubToken = env["GITHUB_TOKEN"];
  const missing = [
    ...(githubToken ? [] : ["GITHUB_TOKEN (a GitHub token that can read public repos)"]),
    ...(dryRun || environment.GEMINI_API_KEY ? [] : ["GEMINI_API_KEY"]),
  ];
  if (missing.length > 0 || !githubToken) {
    log(`Missing ${missing.join(" and ")}. Set it in the environment or in .env at the repo root.`);
    return 1;
  }

  try {
    const repositories = await collectRepositories({
      login: target,
      githubToken,
      repoTokenBudget: environment.REPO_TOKEN_BUDGET,
      log,
    });
    for (const repository of repositories) {
      log((repository.included ? formatFacts(repository) : [formatSkipped(repository)]).join("\n"));
    }
    if (dryRun) {
      log("\nDry run: stopped before the model call.");
      return 0;
    }
    if (!environment.GEMINI_API_KEY) return 1;
    const { cv, pages } = await prepareCv(
      values.cv ? await readFile(path.resolve(cwd, values.cv)) : undefined,
    );
    log(`\nJudging with ${environment.GEMINI_MODEL}...`);
    const { judgment, profile } = await judgeAndAggregate({
      personId: target,
      displayName: target,
      geminiApiKey: environment.GEMINI_API_KEY,
      model: environment.GEMINI_MODEL,
      repositories,
      cv,
      pages,
    });
    log(`\n${formatProfile(target, judgment, profile).join("\n")}`);
    return 0;
  } catch (error) {
    if (error instanceof RetryLaterError) {
      log(`${error.message}: rate limited, retry after ${error.retryAt.toISOString()}.`);
      return 75;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // pnpm runs scripts from apps/api; INIT_CWD is where the user typed the command.
  process.exitCode = await runProfileCli(
    process.argv.slice(2),
    process.env,
    (line) => console.log(line),
    process.env["INIT_CWD"] ?? process.cwd(),
  );
}
