import { describe, expect, it } from "vitest";
import { retryDelayMs } from "./queue.js";

describe("job retry delay", () => {
  it("backs off exponentially with bounded jitter", () => {
    expect(retryDelayMs(1, () => 0)).toBe(45_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(120_000);
    expect(retryDelayMs(3, () => 1)).toBe(300_000);
  });

  it("caps the base delay at one hour", () => {
    expect(retryDelayMs(20, () => 0.5)).toBe(3_600_000);
  });
});
