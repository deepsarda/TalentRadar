export const proficiencyRubric = [
  { level: 1, name: "Exposure", anchor: "Tutorial or class work with little original code" },
  {
    level: 2,
    name: "Working",
    anchor: "A small independent build that runs but has limited structure",
  },
  {
    level: 3,
    name: "Solid",
    anchor: "A non-trivial original project with structure, errors, and some tests or CI",
  },
  {
    level: 4,
    name: "Strong",
    anchor: "Clean architecture, advanced idioms, tests, and performance or security care",
  },
  {
    level: 5,
    name: "Exceptional",
    anchor: "Deep work other people rely on, such as merged upstream systems",
  },
] as const;

export const originalityRubric = [
  { level: 1, name: "Copy", anchor: "A template or copied project with trivial changes" },
  { level: 2, name: "Tutorial", anchor: "Closely follows a tutorial or course" },
  { level: 3, name: "Extended", anchor: "A borrowed base with substantial original additions" },
  { level: 4, name: "Original", anchor: "An original project built from established patterns" },
  {
    level: 5,
    name: "Novel",
    anchor: "An original problem and code-level design that is not a known pattern",
  },
] as const;
