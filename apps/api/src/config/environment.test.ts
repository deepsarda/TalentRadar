import { describe, expect, it } from "vitest";
import { readEnvironment } from "./environment.js";

describe("readEnvironment", () => {
  it("treats empty values as unset, the way .env.example ships optional keys", () => {
    const environment = readEnvironment({ RESEND_API_KEY: "", GEMINI_API_KEY: "", PORT: "" });
    expect(environment.RESEND_API_KEY).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.PORT).toBe(3000);
  });

  it("still rejects a value that is set but invalid", () => {
    expect(() => readEnvironment({ SESSION_SECRET: "too-short" })).toThrow();
  });
});
