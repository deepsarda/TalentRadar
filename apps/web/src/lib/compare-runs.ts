import type { DecidedTeam, RankingParams } from "@talentradar/shared";
import type { OrganizerShortlistRun } from "./api.js";

export interface TeamMovement {
  teamId: string;
  name: string;
  previousRank: number | null;
  currentRank: number | null;
  rankDelta: number; // positive = climbed up, negative = dropped down, 0 = unchanged
  previousStatus: DecidedTeam["status"] | "none";
  currentStatus: DecidedTeam["status"] | "none";
  direction: "in" | "out" | "up" | "down" | "same";
  reasons: string[];
}

export interface RunComparison {
  runA: { id: string; name: string };
  runB: { id: string; name: string };
  movedIn: TeamMovement[];
  movedOut: TeamMovement[];
  movedUp: TeamMovement[];
  movedDown: TeamMovement[];
  unchanged: TeamMovement[];
  parameterChanges: string[];
}

function describeParameterChanges(paramsA: RankingParams, paramsB: RankingParams): string[] {
  const changes: string[] = [];
  if (paramsA.alpha !== paramsB.alpha) {
    changes.push(`Alpha changed from ${paramsA.alpha.toFixed(2)} to ${paramsB.alpha.toFixed(2)}`);
  }
  if (paramsA.noveltyWeight !== paramsB.noveltyWeight) {
    changes.push(
      `Novelty weight changed from ${paramsA.noveltyWeight} to ${paramsB.noveltyWeight}`,
    );
  }
  if (paramsA.minFit !== paramsB.minFit) {
    changes.push(
      `Min fit changed from ${Math.round(paramsA.minFit * 100)}% to ${Math.round(paramsB.minFit * 100)}%`,
    );
  }

  const mapA = new Map(paramsA.requirements.map((req) => [req.skill, req]));
  const mapB = new Map(paramsB.requirements.map((req) => [req.skill, req]));

  for (const [skill, reqB] of mapB) {
    const reqA = mapA.get(skill);
    if (!reqA) {
      changes.push(`Added required skill "${skill}" (weight ×${reqB.weight})`);
    } else if (reqA.weight !== reqB.weight) {
      changes.push(`Weight for "${skill}" changed from ×${reqA.weight} to ×${reqB.weight}`);
    } else if (reqA.target !== reqB.target) {
      changes.push(`Target for "${skill}" changed from ${reqA.target} to ${reqB.target}`);
    }
  }

  for (const [skill] of mapA) {
    if (!mapB.has(skill)) {
      changes.push(`Removed required skill "${skill}"`);
    }
  }

  return changes;
}

export function compareRuns(
  runA: OrganizerShortlistRun,
  runB: OrganizerShortlistRun,
): RunComparison {
  const mapA = new Map(runA.results.map((result) => [result.teamId, result]));
  const mapB = new Map(runB.results.map((result) => [result.teamId, result]));

  const allTeamIds = Array.from(new Set([...mapA.keys(), ...mapB.keys()]));
  const paramDiffs = describeParameterChanges(runA.params, runB.params);

  const movements: TeamMovement[] = [];

  for (const teamId of allTeamIds) {
    const resA = mapA.get(teamId);
    const resB = mapB.get(teamId);

    const name = resB?.name ?? resA?.name ?? `Team ${teamId}`;
    const previousRank = resA?.rank ?? null;
    const currentRank = resB?.rank ?? null;
    const previousStatus = resA?.status ?? "none";
    const currentStatus = resB?.status ?? "none";

    let rankDelta = 0;
    if (previousRank != null && currentRank != null) {
      rankDelta = previousRank - currentRank; // rank 5 -> rank 3 = +2
    }

    const wasSelected = previousStatus === "selected";
    const isSelected = currentStatus === "selected";

    let direction: TeamMovement["direction"] = "same";
    if (!wasSelected && isSelected) {
      direction = "in";
    } else if (wasSelected && !isSelected) {
      direction = "out";
    } else if (rankDelta > 0) {
      direction = "up";
    } else if (rankDelta < 0) {
      direction = "down";
    }

    const reasons: string[] = [];
    if (direction === "in") {
      if (resB?.override?.action === "pin_in") {
        reasons.push(`Manually pinned in: "${resB.override.reason}"`);
      } else if (resB?.quotaSwap === "added") {
        reasons.push("Selected via quota swap");
      } else if (resA && resB) {
        const scoreDiff = resB.score - resA.score;
        reasons.push(
          `Score changed from ${resA.score.toFixed(1)} to ${resB.score.toFixed(1)} (${scoreDiff >= 0 ? "+" : ""}${scoreDiff.toFixed(1)})`,
        );
      } else {
        reasons.push("Ranked into selection seats");
      }
    } else if (direction === "out") {
      if (resB?.override?.action === "pin_out") {
        reasons.push(`Manually pinned out: "${resB.override.reason}"`);
      } else if (resA?.quotaSwap === "removed" || resB?.quotaSwap === "removed") {
        reasons.push("Displaced by quota balance rule");
      } else if (resA && resB) {
        const scoreDiff = resB.score - resA.score;
        reasons.push(
          `Score changed from ${resA.score.toFixed(1)} to ${resB.score.toFixed(1)} (${scoreDiff >= 0 ? "+" : ""}${scoreDiff.toFixed(1)})`,
        );
      } else {
        reasons.push("Pushed below cutoff capacity");
      }
    } else if (direction === "up" || direction === "down") {
      if (resA && resB) {
        const scoreDiff = resB.score - resA.score;
        reasons.push(
          `Score diff: ${scoreDiff >= 0 ? "+" : ""}${scoreDiff.toFixed(1)} pts (rank ${previousRank} → ${currentRank})`,
        );
      }
    }

    movements.push({
      teamId,
      name,
      previousRank,
      currentRank,
      rankDelta,
      previousStatus,
      currentStatus,
      direction,
      reasons,
    });
  }

  return {
    runA: { id: runA.id, name: runA.name },
    runB: { id: runB.id, name: runB.name },
    movedIn: movements.filter((m) => m.direction === "in"),
    movedOut: movements.filter((m) => m.direction === "out"),
    movedUp: movements.filter((m) => m.direction === "up"),
    movedDown: movements.filter((m) => m.direction === "down"),
    unchanged: movements.filter((m) => m.direction === "same"),
    parameterChanges: paramDiffs,
  };
}
