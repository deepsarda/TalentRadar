import { taxonomy, taxonomyIds } from "@talentradar/shared";
import { fewShots } from "../profile-pipeline/few-shot.js";
import {
  fixedPromptPrefix,
  JUDGE_MAX_OUTPUT_TOKENS,
  JUDGE_THINKING_LEVEL,
  responseSchema,
} from "../profile-pipeline/judge.js";

/** Offline prompt-size report (characters / 4, the same estimate the rate limiter uses). */
const tokens = (text: string) => Math.ceil(text.length / 4);
const shotsStart = fixedPromptPrefix.indexOf("Worked examples follow");
const row = (label: string, value: string | number) => console.info(`${label.padEnd(44)} ${value}`);

row("taxonomy version", taxonomy.version);
row(
  "domains / technologies / ids",
  `${Object.keys(taxonomy.domains).length} / ${Object.keys(taxonomy.technologies).length} / ${taxonomyIds.length}`,
);
row("instructions + rubrics + taxonomy (~tokens)", tokens(fixedPromptPrefix.slice(0, shotsStart)));
row(`few-shot examples x${fewShots.length} (~tokens)`, tokens(fixedPromptPrefix.slice(shotsStart)));
row("fixed prefix total (~tokens)", tokens(fixedPromptPrefix));
row("response schema (~tokens)", tokens(JSON.stringify(responseSchema())));
row(
  "worst case: prefix + 6 repos x 12,000 + CV (~tokens)",
  tokens(fixedPromptPrefix) + 72_000 + 3_774,
);
row("thinking level / max output tokens", `${JUDGE_THINKING_LEVEL} / ${JUDGE_MAX_OUTPUT_TOKENS}`);
