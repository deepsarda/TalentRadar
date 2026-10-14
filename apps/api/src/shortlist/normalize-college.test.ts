import { describe, expect, it } from "vitest";
import { normalizeCollege } from "./normalize-college.js";

const aliases = {
  "SVNIT Surat": ["SVNIT", "NIT Surat", "Sardar Vallabhbhai National Institute of Technology"],
};

describe("normalizeCollege", () => {
  it("maps canonical names and aliases without case or spacing sensitivity", () => {
    expect(normalizeCollege("  nit   SURAT ", aliases)).toEqual({
      value: "SVNIT Surat",
      mapped: true,
    });
    expect(normalizeCollege("svnit surat", aliases)).toEqual({
      value: "SVNIT Surat",
      mapped: true,
    });
  });

  it("preserves a cleaned value when no alias exists", () => {
    expect(normalizeCollege("  DA-IICT   Gandhinagar ", aliases)).toEqual({
      value: "DA-IICT Gandhinagar",
      mapped: false,
    });
  });
});
