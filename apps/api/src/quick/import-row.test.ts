import { describe, expect, it } from "vitest";
import { selectRecentRepositories } from "./import-row.js";

const repo = (name: string, overrides: Record<string, unknown> = {}) => ({
  full_name: `riya/${name}`,
  name,
  fork: false,
  archived: false,
  size: 100,
  pushed_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("selectRecentRepositories", () => {
  it("keeps the six newest original repositories and skips forks, archives and the README repo", async () => {
    const listing = [
      repo("riya"),
      repo("forked", { fork: true }),
      repo("old", { archived: true }),
      repo("empty", { size: 0 }),
      repo("huge", { size: 60_000 }),
      ...["a", "b", "c", "d", "e", "f", "g"].map((name) => repo(name)),
    ];
    const fetchListing = (async () => Response.json(listing)) as typeof fetch;
    const selected = await selectRecentRepositories("Riya", "token", fetchListing);
    expect(selected.map((repository) => repository.fullName)).toEqual(
      ["a", "b", "c", "d", "e", "f"].map((name) => `riya/${name}`),
    );
  });

  it("names a missing GitHub user", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    await expect(selectRecentRepositories("ghost", "token", notFound)).rejects.toThrow(
      "GitHub user @ghost was not found",
    );
  });
});
