import { describe, expect, it } from "vitest";
import { extractCvDetails } from "./cv-details.js";

describe("CV detail extraction", () => {
  it("prefills fields the CV states explicitly", () => {
    const text = [
      "RIYA SHARMA",
      "riya@example.com | github.com/riya",
      "EDUCATION",
      "Sardar Vallabhbhai National Institute of Technology, Surat | 2023 – 2027 | CGPA 8.9",
      "B.Tech in Computer Science and Engineering — third year",
    ].join("\n");
    expect(extractCvDetails(text)).toEqual({
      name: "Riya Sharma",
      college: "Sardar Vallabhbhai National Institute of Technology, Surat",
      branch: "Computer Science and Engineering",
      year: "3",
    });
  });

  it("leaves fields empty rather than guessing", () => {
    const text = [
      "Curriculum Vitae",
      "Worked on artificial intelligence projects",
      "CSE, graduating 2026",
    ].join("\n");
    expect(extractCvDetails(text)).toEqual({});
  });
});
