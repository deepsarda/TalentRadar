import { describe, expect, it } from "vitest";
import { originalityRubric, proficiencyRubric } from "./rubrics.js";
import { taxonomy } from "./taxonomy.js";
import { rubricVersion, taxonomyVersion } from "./versions.js";

/** FNV-1a over the JSON text: enough to notice any edit (shared has no node:crypto types). */
function fingerprint(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(value)) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/*
 * If one of these fails you changed versioned content. Bump the version in versions.ts (or the
 * "version" field in taxonomy.json), then record the new version and fingerprint here.
 */
const pinned = {
  taxonomy: {
    version: "v3",
    fingerprint: "396a7f0a",
  },
  rubric: {
    version: "v1",
    fingerprint: "1aaea3dd",
  },
};

describe("version identifiers", () => {
  it("taxonomy version comes from taxonomy.json and matches its content", () => {
    expect(taxonomyVersion).toBe(taxonomy.version);
    expect({ version: taxonomyVersion, fingerprint: fingerprint(taxonomy) }).toEqual(
      pinned.taxonomy,
    );
  });

  it("rubric version matches the rubric text", () => {
    expect({
      version: rubricVersion,
      fingerprint: fingerprint({ proficiencyRubric, originalityRubric }),
    }).toEqual(pinned.rubric);
  });
});
