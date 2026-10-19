import {
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  type GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiLimiter } from "../jobs/rate-limit.js";
import { fewShots } from "./few-shot.js";
import { JudgeOutputError, judgeProfile, noCv, type RepositoryFacts } from "./judge.js";

const shot = fewShots.at(-1);
if (!shot) throw new Error("technology-coverage fixture is required");
const expected = shot.expected;
const repository: RepositoryFacts = {
  repository: shot.input.repository,
  included: true,
  commitSha: "a".repeat(40),
  pushedAt: "2026-10-01T00:00:00Z",
  authorship: shot.input.facts.authorship,
  languages: shot.input.facts.languages,
  hasTests: shot.input.facts.hasTests,
  hasCi: shot.input.facts.hasCi,
  containerized: shot.input.facts.containerized,
  technologyMatches: shot.input.facts.technologyHints,
  selectedFiles: shot.input.files,
  tree: shot.input.tree,
};

function responseWith(text: string | undefined, finishReason?: FinishReason) {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      ...(finishReason ? { finishReason } : {}),
      ...(text === undefined ? {} : { content: { parts: [{ text }] } }),
    },
  ];
  response.usageMetadata = {
    candidatesTokenCount: 2500,
    thoughtsTokenCount: 60_000,
    totalTokenCount: 80_000,
  };
  return response;
}

function clientFor(response: GenerateContentResponse) {
  const generateContent = vi.fn().mockResolvedValue(response);
  return { ai: { models: { generateContent } } as unknown as GoogleGenAI, generateContent };
}

const settle = vi.fn();
beforeEach(() => {
  settle.mockClear();
  vi.spyOn(geminiLimiter, "acquire").mockResolvedValue(settle);
});
afterEach(() => vi.restoreAllMocks());

describe("judge response completion", () => {
  it("distinguishes SDK response decoding failures from invalid assessment JSON", async () => {
    const { ai, generateContent } = clientFor(responseWith(undefined));
    generateContent.mockRejectedValue(new SyntaxError("Unterminated string: private-canary-name"));
    const outcome = judgeProfile({
      ai,
      model: "test",
      repositories: [repository],
      cv: noCv,
      pages: [],
      attempt: 1,
    });
    await expect(outcome).rejects.toThrow(
      /transport returned invalid response JSON before completion metadata/,
    );
    await expect(outcome).rejects.not.toThrow("private-canary-name");
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(["unfinished", "parseable"])(
    "rejects a %s token-limited answer before accepting any assessment",
    async (kind) => {
      const text =
        kind === "unfinished" ? '{"thoughts":"private-canary-name' : JSON.stringify(expected);
      const { ai } = clientFor(responseWith(text, FinishReason.MAX_TOKENS));
      const onResponse = vi.fn().mockResolvedValue(undefined);
      const outcome = judgeProfile({
        ai,
        model: "test",
        repositories: [repository],
        cv: noCv,
        pages: [],
        attempt: 1,
        onResponse,
      });
      await expect(outcome).rejects.toBeInstanceOf(JudgeOutputError);
      await expect(outcome).rejects.toThrow(
        /cut off.*finish=MAX_TOKENS.*output=2500.*thinking=60000/,
      );
      await expect(outcome).rejects.not.toThrow("private-canary-name");
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({ finishReason: FinishReason.MAX_TOKENS, thinkingTokens: 60_000 }),
      );
      expect(settle).toHaveBeenCalledWith(80_000);
    },
  );

  it.each([FinishReason.SAFETY, FinishReason.RECITATION, undefined])(
    "rejects an abnormal or missing finish reason: %s",
    async (reason) => {
      const { ai } = clientFor(responseWith(JSON.stringify(expected), reason));
      await expect(
        judgeProfile({
          ai,
          model: "test",
          repositories: [repository],
          cv: noCv,
          pages: [],
          attempt: 1,
        }),
      ).rejects.toThrow(/did not complete normally/);
    },
  );

  it("reports a prompt block even when there are no candidates", async () => {
    const response = new GenerateContentResponse();
    response.promptFeedback = { blockReason: BlockedReason.SAFETY };
    const { ai } = clientFor(response);
    await expect(
      judgeProfile({
        ai,
        model: "test",
        repositories: [repository],
        cv: noCv,
        pages: [],
        attempt: 1,
      }),
    ).rejects.toThrow(/finish=SAFETY; 0 chars/);
  });

  it("reports malformed JSON after STOP without logging participant text", async () => {
    const { ai } = clientFor(responseWith('{"thoughts":"private-canary-name', FinishReason.STOP));
    const outcome = judgeProfile({
      ai,
      model: "test",
      repositories: [repository],
      cv: noCv,
      pages: [],
      attempt: 1,
    });
    await expect(outcome).rejects.toThrow(/invalid JSON despite a normal stop.*finish=STOP/);
    await expect(outcome).rejects.not.toThrow("private-canary-name");
  });

  it("reports empty and schema-invalid STOP responses explicitly", async () => {
    for (const [text, message] of [
      [undefined, "no assessment text"],
      ["{}", "invalid response structure"],
    ] as const) {
      const { ai } = clientFor(responseWith(text, FinishReason.STOP));
      await expect(
        judgeProfile({
          ai,
          model: "test",
          repositories: [repository],
          cv: noCv,
          pages: [],
          attempt: 1,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("accepts a complete assessment, keeps its technologies and reports usage", async () => {
    const text = JSON.stringify(expected);
    const { ai } = clientFor(responseWith(text, FinishReason.STOP));
    const result = await judgeProfile({
      ai,
      model: "test",
      repositories: [repository],
      cv: noCv,
      pages: [],
      attempt: 1,
    });
    expect(result.rawText).toBe(text);
    expect(result.result.repos[0]?.skills.filter((skill) => skill.level > 0)).toHaveLength(19);
    expect(result.diagnostics).toMatchObject({
      finishReason: FinishReason.STOP,
      outputTokens: 2500,
      thinkingTokens: 60_000,
    });
  });

  it("identifies the invalid domain field without logging the rejected value", async () => {
    const raw = structuredClone(expected);
    const repo = raw.repos[0] as {
      domains: Record<string, { level: number; thought: string; evidence: unknown[] }>;
    };
    const backend = repo.domains["backend"];
    if (!backend) throw new Error("fixture requires backend");
    backend.evidence = [];
    backend.thought = "private-canary-name";
    const { ai } = clientFor(responseWith(JSON.stringify(raw), FinishReason.STOP));
    const outcome = judgeProfile({
      ai,
      model: "test",
      repositories: [repository],
      cv: noCv,
      pages: [],
      attempt: 1,
    });
    await expect(outcome).rejects.toThrow(/repos\[0\].domains.backend: score_evidence_mismatch/);
    await expect(outcome).rejects.not.toThrow("private-canary-name");
  });

  it("requests compact retry delivery while preserving review depth, all six repositories and their files", async () => {
    const repositories = Array.from({ length: 6 }, (_, index) => ({
      ...repository,
      repository: `example/project-${index}`,
    }));
    const { ai, generateContent } = clientFor(
      responseWith(
        JSON.stringify({
          ...expected,
          repos: repositories.map((facts) => ({
            ...(expected.repos[0] as Record<string, unknown>),
            repo: facts.repository,
          })),
        }),
        FinishReason.STOP,
      ),
    );
    for (const attempt of [1, 2]) {
      await judgeProfile({ ai, model: "test", repositories, cv: noCv, pages: [], attempt });
    }
    const first = generateContent.mock.calls[0]?.[0];
    const retry = generateContent.mock.calls[1]?.[0];
    expect(first.config.thinkingConfig.thinkingLevel).toBe(ThinkingLevel.MEDIUM);
    expect(retry.config.thinkingConfig.thinkingLevel).toBe(ThinkingLevel.MEDIUM);
    expect(retry.config.maxOutputTokens).toBe(65_536);
    expect(retry.contents[0].text).toContain("DELIVERY RETRY");
    for (const facts of repositories) {
      expect(retry.contents[0].text).toContain(facts.repository);
      for (const file of facts.selectedFiles)
        expect(retry.contents[0].text).toContain(JSON.stringify(file));
    }
    expect(retry.contents[0].text).toContain(
      "Keep every supported technology and every repository",
    );
  });
});
