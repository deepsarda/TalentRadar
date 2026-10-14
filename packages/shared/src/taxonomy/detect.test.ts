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
});
