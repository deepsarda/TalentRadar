import { GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import { type FewShot, fewShots } from "./few-shot.js";
import {
  buildPrompt,
  JUDGE_MAX_OUTPUT_TOKENS,
  judgeGenerationConfig,
  judgeProfile,
  noCv,
  type RepositoryFacts,
  responseSchema,
} from "./judge.js";

/*
 * A2 Day-2 tests against the pinned model. They spend real quota, so they only run when
 * GEMINI_API_KEY is set. Use the DEV Google Cloud project, never the demo one, and only the
 * synthetic few-shot input below (no CV): free-tier content may be used to improve Google's
 * products.
 *
 *   GEMINI_API_KEY=... pnpm --filter @talentradar/api run validate:judge
 *
 *  1. Request acceptance: the schema (without an id enum) and the lowest thinking level are
 *     accepted by the pinned model.
 *  2. Key order: the RAW response string keeps reasoning before verdict, not alphabetical order.
 *  3. Limits: output stays well under the 16,000-token cap, and hidden thinking stays small.
 */

interface SchemaNode {
  propertyOrdering?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

function expectKeyOrder(value: unknown, schema: SchemaNode, at: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (schema.items) expectKeyOrder(item, schema.items, `${at}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== "object" || !schema.properties) return;
  const keys = Object.keys(value);
  const order = schema.propertyOrdering ?? Object.keys(schema.properties);
  expect(keys, at).toEqual(order.filter((key) => keys.includes(key)));
  for (const key of keys) {
    const child = schema.properties[key];
    if (child) expectKeyOrder((value as Record<string, unknown>)[key], child, `${at}.${key}`);
  }
}

function factsFor(shot: FewShot): RepositoryFacts {
  return {
    repository: shot.input.repository,
    included: true,
    commitSha: "0".repeat(40),
    pushedAt: "2026-09-01T00:00:00Z",
    authorship: shot.input.facts.authorship,
    languages: shot.input.facts.languages,
    hasTests: shot.input.facts.hasTests,
    hasCi: shot.input.facts.hasCi,
    containerized: shot.input.facts.containerized,
    technologyMatches: shot.input.facts.technologyHints,
    tree: shot.input.tree,
    ...(shot.input.readmePath ? { readmePath: shot.input.readmePath } : {}),
    ...(shot.input.readme ? { readme: shot.input.readme } : {}),
    selectedFiles: shot.input.files,
  };
}

describe("pinned Gemini model (live, Day-2 tests)", () => {
  const apiKey = process.env["GEMINI_API_KEY"];
  const model = process.env["GEMINI_MODEL"] ?? "gemini-3.1-flash-lite";
  const shot = fewShots[4] as FewShot;

  it.skipIf(!apiKey)(
    "accepts the schema and lowest thinking level, and keeps reasoning-before-verdict key order",
    async () => {
      const { rawText, result } = await judgeProfile({
        ai: new GoogleGenAI({ apiKey: apiKey ?? "" }),
        model,
        repositories: [factsFor(shot)],
        cv: noCv,
        pages: [],
        attempt: 1,
      });
      // JSON.parse keeps the raw string's key order for non-numeric keys.
      const raw: unknown = JSON.parse(rawText);
      expectKeyOrder(raw, responseSchema() as SchemaNode, "$");
      expect(rawText.indexOf('"thoughts"')).toBeLessThan(rawText.indexOf('"summary"'));
      expect(result.repos).toHaveLength(1);
    },
    120_000,
  );

  it.skipIf(!apiKey)(
    "finishes normally, far under the output cap, with little hidden thinking",
    async () => {
      const ai = new GoogleGenAI({ apiKey: apiKey ?? "" });
      const response = await ai.models.generateContent({
        model,
        contents: [{ text: buildPrompt([factsFor(shot)], noCv, 0) }],
        config: judgeGenerationConfig(),
      });
      expect(response.candidates?.[0]?.finishReason).toBe("STOP");
      const usage = response.usageMetadata;
      expect(usage?.candidatesTokenCount ?? 0).toBeLessThan(JUDGE_MAX_OUTPUT_TOKENS / 2);
      expect(usage?.thoughtsTokenCount ?? 0).toBeLessThan(1_000);
      console.info(
        `prompt ${usage?.promptTokenCount} tokens, output ${usage?.candidatesTokenCount}, hidden thinking ${usage?.thoughtsTokenCount ?? 0}`,
      );
    },
    120_000,
  );
});
