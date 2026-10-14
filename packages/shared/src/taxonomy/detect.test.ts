import { describe, expect, it } from "vitest";
import { detectTechnologies, validateTaxonomy } from "./detect.js";

describe("taxonomy", () => {
  it("contains no structural errors", () => {
    expect(validateTaxonomy().filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports manifest, language, file, and extension matches", () => {
    const matches = detectTechnologies({
      languages: ["TypeScript"],
      files: {
        "package.json": JSON.stringify({ dependencies: { react: "19.0.0", express: "5.0.0" } }),
        "src/App.tsx": "import React from 'react';",
        Dockerfile: "FROM node:24",
      },
    });
    const ids = new Set(matches.map((match) => match.id));
    expect(ids).toEqual(
      expect.objectContaining(new Set(["typescript", "react", "express", "docker"])),
    );
  });

  it("reads manifests in subfolders, as monorepos keep them", () => {
    const matches = detectTechnologies({
      files: {
        "client/package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
        "server/requirements.txt": "fastapi==0.115\n",
        "server/old-package.json.bak": JSON.stringify({ dependencies: { vue: "3" } }),
      },
    });
    expect(matches.map((match) => match.id).sort()).toEqual(["fastapi", "nodejs", "react"]);
  });

  it("treats *.ext file rules as suffix patterns", () => {
    const ids = detectTechnologies({ files: { "api/Api.csproj": "<Project />" } }).map(
      (match) => match.id,
    );
    expect(ids).toContain("dotnet");
  });
});

describe("detection false positives", () => {
  const ids = (files: Record<string, string>, languages: string[] = []) =>
    detectTechnologies({ files, languages }).map((match) => match.id);

  it("doesn't report git for .github or .gitignore (path rules match whole segments)", () => {
    const found = ids({ ".github/workflows/ci.yml": "", ".gitignore": "" });
    expect(found).not.toContain("git");
    expect(found).toContain("github_actions");
  });

  it("only reports nodejs when a package.json exists, not for the word node in code", () => {
    expect(ids({ "src/list.c": "struct node { struct node *next; };" }, ["C"])).not.toContain(
      "nodejs",
    );
    expect(ids({ "package.json": "{}" })).toContain("nodejs");
  });
});
