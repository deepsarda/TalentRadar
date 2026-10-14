import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { promptVersion, taxonomyIds } from "@talentradar/shared";
import { describe, expect, it } from "vitest";
import { type FewShot, fewShots } from "./few-shot.js";
import {
  fixedPromptPrefix,
  judgeProfile,
  noCv,
  RawResponseSchema,
  type RepositoryFacts,
  responseSchema,
  sanitizeResponse,
} from "./judge.js";

/*
 * If this fails you changed the judge prompt (instructions, rubric text, taxonomy or a shot).
 * Bump promptVersion in packages/shared/src/taxonomy/versions.ts, then record both values here.
 */
const pinnedPrompt = {
  version: "v2",
  fingerprint: "92fe19186ab4984253d3a3d4134d64f13f540b1a0543ea9d6ab80c52de3a06a6",
};

interface SchemaNode {
  propertyOrdering?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** Fails when an object's keys are not in the schema's reasoning-before-verdict order. */
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

/** The stage-2 facts that would have produced this shot's prompt input. */
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

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe.each(fewShots.map((shot) => [shot.teaches, shot] as const))("few-shot: %s", (_, shot) => {
  const cited = shot.expected.repos.flatMap((repo) =>
    (repo as { skills: Array<{ evidence: Array<{ path: string }> }> }).skills.flatMap((skill) =>
      skill.evidence.map((item) => item.path),
    ),
  );

  it("parses with the real output schema and loses nothing in per-block validation", () => {
    const parsed = RawResponseSchema.parse(shot.expected);
    const facts = factsFor(shot);
    const sanitized = sanitizeResponse(parsed, [facts], noCv);
    expect(sanitized.repos).toHaveLength(parsed.repos.length);
    expect(sanitized.repos.flatMap((repo) => repo.skills.flatMap((s) => s.evidence))).toHaveLength(
      cited.length,
    );
  });

  it("keeps reasoning-before-verdict key order", () => {
    expectKeyOrder(shot.expected, responseSchema() as SchemaNode, "$");
  });

  it("cites only files sent for its own repository, all present in its tree", () => {
    const sent = new Set([
      ...shot.input.files.map((file) => file.path),
      ...(shot.input.readmePath ? [shot.input.readmePath] : []),
    ]);
    expect(cited.length).toBeGreaterThan(0);
    for (const path of cited) {
      expect(sent.has(path), path).toBe(true);
      expect(shot.input.tree, path).toContain(path);
    }
    for (const file of shot.input.files) expect(shot.input.tree).toContain(file.path);
  });

  it("keeps every thought under about 60 words and the shot near 2k tokens", () => {
    const thoughts = [
      shot.expected.thoughts,
      ...shot.expected.repos.flatMap((repo) => {
        const block = repo as { thoughts: string; skills: Array<{ thought: string }> };
        return [block.thoughts, ...block.skills.map((skill) => skill.thought)];
      }),
    ];
    for (const thought of thoughts) expect(words(thought), thought).toBeLessThanOrEqual(65);
    const tokens = JSON.stringify(shot).length / 4;
    expect(tokens).toBeGreaterThan(1_000);
    expect(tokens).toBeLessThan(3_500);
  });
});

describe("few-shot set", () => {
  const repo = (index: number) =>
    fewShots[index]?.expected.repos[0] as {
      originality: number;
      flags: string[];
      skills: Array<{ id: string; level: number; evidence: Array<{ path: string }> }>;
    };

  it("teaches what the spec's table says each shot teaches", () => {
    expect(fewShots).toHaveLength(5);
    const tutorial = repo(0);
    expect(tutorial.originality).toBe(2);
    expect(tutorial.skills.every((skill) => skill.level <= 2)).toBe(true);
    const solid = repo(1);
    expect(solid.originality).toBe(4);
    expect(solid.skills.every((skill) => skill.level === 3)).toBe(true);
    const novel = repo(2);
    expect(novel.originality).toBe(5);
    expect(novel.skills.some((skill) => skill.level >= 3)).toBe(true);
    const overclaim = repo(3);
    expect([2, 3]).toContain(overclaim.originality);
    expect(overclaim.flags).toContain("readme_overclaims");
    const injection = repo(4);
    expect(injection.flags).toContain("possible_prompt_injection");
    expect(injection.skills.every((skill) => skill.level < 5)).toBe(true);
  });

  it("comes from five different domains with no shared skill ids", () => {
    const ids = fewShots.map((_, index) => repo(index).skills.map((skill) => skill.id));
    expect(new Set(ids.flat()).size).toBe(ids.flat().length);
  });

  it("is clearly synthetic", () => {
    for (const shot of fewShots) expect(shot.input.repository).toMatch(/^example-user-\d\//);
  });

  it("is pinned to the prompt version", () => {
    expect({
      version: promptVersion,
      fingerprint: createHash("sha256").update(fixedPromptPrefix).digest("hex"),
    }).toEqual(pinnedPrompt);
  });
});

/*
 * Spec Day-2 tests against the pinned model; they spend real quota, so they only run with
 * GEMINI_API_KEY set (free tier: the input below is a synthetic shot, no CV).
 *  1. Enum size: the request carries the full taxonomy enum (every id) and the full JSON schema,
 *     and Gemini accepts it. If it is rejected as too large, the spec's fallback applies: drop the
 *     enum from responseSchema() and rely on the prompt list plus sanitizeResponse's id check.
 *  2. Key order: the RAW response string keeps reasoning before verdict (thoughts before summary,
 *     repo thoughts before originality, evidence -> thought -> level), not alphabetical order.
 */
describe("pinned Gemini model (live, Day-2 tests)", () => {
  const apiKey = process.env["GEMINI_API_KEY"];
  const model = process.env["GEMINI_MODEL"] ?? "gemini-3.1-flash-lite";

  it.skipIf(!apiKey)(
    "accepts the full taxonomy enum and schema, and keeps reasoning-before-verdict key order",
    async () => {
      const shot = fewShots[4] as FewShot;
      const schema = responseSchema() as SchemaNode & { properties: Record<string, unknown> };
      expect(JSON.stringify(schema)).toContain(`"enum":${JSON.stringify(taxonomyIds)}`);
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
      expectKeyOrder(raw, schema, "$");
      expect(rawText.indexOf('"thoughts"')).toBeLessThan(rawText.indexOf('"summary"'));
      expect(result.repos).toHaveLength(1);
    },
    120_000,
  );
});
