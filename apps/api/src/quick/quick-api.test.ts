import { describe, expect, it } from "vitest";
import { normalizeGithub, parseCsv, suggestedMapping } from "./quick-api.js";

describe("Quick Shortlist input parsing", () => {
  it("parses a BOM-prefixed CSV without losing quoted values", () => {
    const parsed = parseCsv(
      Buffer.from('\uFEFFFull Name,Email Address,College\n"Patel, Riya",riya@example.com,SVNIT\n'),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.headers).toEqual(["Full Name", "Email Address", "College"]);
    expect(parsed.rows).toEqual([
      {
        "Full Name": "Patel, Riya",
        "Email Address": "riya@example.com",
        College: "SVNIT",
      },
    ]);
  });

  it("suggests only recognized column mappings", () => {
    expect(
      suggestedMapping(["Participant Name", "E-mail", "GitHub Profile Link", "Unrelated answer"]),
    ).toEqual({
      name: "Participant Name",
      email: "E-mail",
      github: "GitHub Profile Link",
    });
  });

  it("normalizes supported GitHub profile formats", () => {
    expect(normalizeGithub("@riya-dev")).toBe("riya-dev");
    expect(normalizeGithub("https://github.com/riya-dev/")).toBe("riya-dev");
    expect(normalizeGithub("github.com/riya-dev")).toBe("riya-dev");
    expect(normalizeGithub("  ")).toBeUndefined();
  });
});
