import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * Reads the feedback export (from GET /api/organizer/.../feedback-export) and suggests
 * weight adjustments based on the correlation between override patterns and outcome ratings.
 *
 * NEVER auto-applies anything. Output is a human-readable suggestion table only.
 */

interface FeedbackExport {
  eventId: string;
  eventName: string;
  runs: Array<{
    runId: string;
    runName: string;
    params: {
      requirements: Array<{ skill: string; weight: number }>;
      alpha: number;
      noveltyWeight: number;
    };
    overrides: Array<{ teamId: string; action: string; reason: string }>;
    outcomeRatings: Array<{ teamId: string; rating: number; note?: string }>;
  }>;
}

function suggestWeightAdjustments(data: FeedbackExport, log: (line: string) => void): void {
  log(`\nFeedback analysis for event: ${data.eventName}`);
  log(`${"=".repeat(60)}\n`);

  // Collect all ratings across runs
  const allRatings: Array<{ teamId: string; rating: number; overrideAction?: string | undefined }> =
    [];
  for (const run of data.runs) {
    const overrideByTeam = new Map(run.overrides.map((o) => [o.teamId, o.action]));
    for (const rating of run.outcomeRatings) {
      allRatings.push({
        teamId: rating.teamId,
        rating: rating.rating,
        overrideAction: overrideByTeam.get(rating.teamId),
      });
    }
  }

  if (allRatings.length === 0) {
    log("No outcome ratings recorded yet. Run an event and rate teams to get suggestions.");
    return;
  }

  log(`Total rated teams: ${allRatings.length}`);
  const pinInRatings = allRatings.filter((r) => r.overrideAction === "pin_in").map((r) => r.rating);
  const pinOutRatings = allRatings
    .filter((r) => r.overrideAction === "pin_out")
    .map((r) => r.rating);
  const noOverrideRatings = allRatings.filter((r) => !r.overrideAction).map((r) => r.rating);

  const avg = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;

  log(`\nOutcome ratings by selection type:`);
  log(
    `  Organizer pin-ins : ${pinInRatings.length} teams, avg rating ${avg(pinInRatings).toFixed(2)}`,
  );
  log(
    `  Organizer pin-outs: ${pinOutRatings.length} teams, avg rating ${avg(pinOutRatings).toFixed(2)}`,
  );
  log(
    `  Algorithm-selected: ${noOverrideRatings.length} teams, avg rating ${avg(noOverrideRatings).toFixed(2)}`,
  );

  log(`\nSuggested weight adjustments (NEVER auto-applied — review before using):`);

  // If pin-in teams consistently outperform algorithm-selected, suggest weighting differently
  const pinInAvg = avg(pinInRatings);
  const algorithmAvg = avg(noOverrideRatings);
  if (pinInRatings.length >= 3 && algorithmAvg > 0) {
    const ratio = pinInAvg / algorithmAvg;
    if (ratio > 1.2) {
      log(
        `  ⚠  Pin-in teams rated ${((ratio - 1) * 100).toFixed(0)}% higher than algorithm picks.`,
      );
      log(`     Consider: review alpha (currently ${data.runs[0]?.params.alpha ?? "unknown"}).`);
      log(
        `     Suggestion: if you value depth over fit, try alpha 0.5–0.6 (current: ${data.runs[0]?.params.alpha ?? "?"}).`,
      );
    } else if (ratio < 0.8) {
      log(
        `  ✓  Algorithm-selected teams rated higher than pin-ins. Algorithm appears well-calibrated.`,
      );
    } else {
      log(
        `  ✓  Pin-in and algorithm-selected teams perform similarly. No urgent changes suggested.`,
      );
    }
  } else {
    log(`  Not enough data yet (need ≥ 3 rated pin-in teams for comparison).`);
  }

  log(`\n${"=".repeat(60)}`);
  log(`REMINDER: These are suggestions only. Apply changes manually after reviewing.`);
}

export async function runSuggestWeights(
  argv: string[],
  log: (line: string) => void,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: "string" } },
  });

  const filePath = values.file;
  if (!filePath) {
    log("Usage: suggest-weights --file <feedback-export.json>");
    return 1;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    log(`Cannot read file: ${filePath}`);
    return 1;
  }

  let data: FeedbackExport;
  try {
    data = JSON.parse(raw) as FeedbackExport;
  } catch {
    log("Invalid JSON in feedback export file.");
    return 1;
  }

  suggestWeightAdjustments(data, log);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSuggestWeights(process.argv.slice(2), console.log);
}
