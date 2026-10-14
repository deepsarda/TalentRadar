import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { detectTechnologies } from "@talentradar/shared";
import { readEnvironment } from "../config/environment.js";
import { runCommand } from "../profile-pipeline/commands.js";
import type { Log } from "../profile-pipeline/local-run.js";
import { extractCheckout } from "../profile-pipeline/repository.js";
import { formatMatches } from "./format.js";

const usage = `Usage: pnpm detect-report <path-to-local-git-checkout> [--languages TypeScript,CSS]

Runs the stage-2 manifest and technology detectors on a local checkout, exactly as the worker does
after cloning, and prints every match with its reasons plus the manifests that matched nothing.
--languages stands in for GitHub's languages API, which a local checkout does not have.`;

/** The CLI body, injectable for tests. Returns the process exit code. */
export async function runDetectReport(
  argv: string[],
  env: NodeJS.ProcessEnv,
  log: Log,
  cwd = process.cwd(),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { languages: { type: "string" }, help: { type: "boolean", default: false } },
  });
  const target = positionals[0];
  if (values.help || !target || positionals.length > 1) {
    log(usage);
    return values.help ? 0 : 2;
  }
  const checkout = path.resolve(cwd, target);
  const isDirectory = await stat(checkout).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDirectory) {
    log(`${checkout} is not a directory.\n\n${usage}`);
    return 2;
  }
  const languageNames = (values.languages ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  let extracted: Awaited<ReturnType<typeof extractCheckout>>;
  try {
    extracted = await extractCheckout(checkout, {
      repoTokenBudget: readEnvironment(env).REPO_TOKEN_BUDGET,
      // Only the names matter to the detectors; byte counts come from GitHub in production.
      languages: Object.fromEntries(languageNames.map((name) => [name, 0])),
    });
  } catch (error) {
    log(
      `Could not read ${checkout} as a git checkout (stage 2 lists files with git ls-files): ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // extractCheckout reports manifests lower-cased; map them back to real paths to read them.
  const tracked = (
    await runCommand("git", ["-C", checkout, "ls-files", "-z"], { timeoutMs: 20_000 })
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const unmatched: string[] = [];
  for (const manifest of extracted.manifests) {
    const realPath = tracked.find((file) => file.toLowerCase() === manifest) ?? manifest;
    const content = await readFile(path.join(checkout, realPath), "utf8");
    if (detectTechnologies({ files: { [manifest]: content } }).length === 0)
      unmatched.push(realPath);
  }

  log(`Detector report for ${checkout} @ ${extracted.commitSha.slice(0, 12)}`);
  log(`\nMatches (${extracted.technologyMatches.length}), from manifests and sampled files:`);
  log(formatMatches(extracted.technologyMatches).join("\n"));
  log(
    `\nManifests read (${extracted.manifests.length}): ${extracted.manifests.join(", ") || "(none)"}`,
  );
  log(
    `Unmatched manifests (${unmatched.length}): ${unmatched.join(", ") || "(none)"}${unmatched.length > 0 ? "\n  Their dependencies have no taxonomy entry, or the ecosystem has no parser yet." : ""}`,
  );
  log(`\nSampled files (${extracted.selectedFiles.length}):`);
  for (const file of extracted.selectedFiles) log(`  ${file.path}`);
  if (languageNames.length === 0) {
    log("\nNo --languages given, so language rules (e.g. TypeScript) were not evaluated.");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // pnpm runs scripts from apps/api; INIT_CWD is where the user typed the command.
  process.exitCode = await runDetectReport(
    process.argv.slice(2),
    process.env,
    (line) => console.log(line),
    process.env["INIT_CWD"] ?? process.cwd(),
  );
}
