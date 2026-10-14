import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../layouts/TerminalFrame";
import { splitSkills } from "../lib/skills";
import { rankSkills } from "./SkillPicker";
import { countdown } from "./ui";

describe("countdown", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");

  it("formats days, hours and minutes with zero padding", () => {
    expect(countdown("2026-10-18T12:33:00Z", now)).toBe("T-minus 04d 12h 33m");
  });

  it("returns null once the moment has passed", () => {
    expect(countdown("2026-10-14T00:00:00Z", now)).toBeNull();
    expect(countdown("2026-10-13T00:00:00Z", now)).toBeNull();
  });
});

describe("fuzzyMatch", () => {
  it("matches characters in order, ignoring case and spaces", () => {
    expect(fuzzyMatch("ostl", "organizer: shortlist")).toBe(true);
    expect(fuzzyMatch("New Ev", "organizer: new event")).toBe(true);
    expect(fuzzyMatch("", "anything")).toBe(true);
  });

  it("rejects out-of-order characters", () => {
    expect(fuzzyMatch("tsoh", "organizer: shortlist")).toBe(false);
  });
});

describe("rankSkills", () => {
  it("puts prefix matches before loose ones", () => {
    expect(rankSkills("rea")[0]?.id).toBe("react");
    expect(rankSkills("dock")[0]?.id).toBe("docker");
  });

  it("hides excluded skills", () => {
    expect(rankSkills("react", ["react"]).some((option) => option.id === "react")).toBe(false);
  });
});

describe("splitSkills", () => {
  it("puts domains under areas and technologies under tools, keeping order", () => {
    const groups = splitSkills(["react", "ai_ml", "docker", "backend"], (id) => id);
    expect(groups).toEqual([
      { label: "areas", items: ["ai_ml", "backend"] },
      { label: "tools", items: ["react", "docker"] },
    ]);
  });

  it("drops an empty group", () => {
    expect(splitSkills(["react"], (id) => id).map((group) => group.label)).toEqual(["tools"]);
  });
});
