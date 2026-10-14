import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * MongoDB doesn't support parallel operations inside one transaction: on Atlas, two operations
 * racing to start it fail with "Only servers in a sharded cluster can start a new transaction at
 * the active transaction number". The in-memory test server doesn't enforce this, so scan the
 * source instead: no Promise.all over session operations inside a withTransaction block.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function transactionBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/withTransaction\(async \(\) => \{/g)) {
    let index = (match.index ?? 0) + match[0].length;
    let depth = 1;
    const start = index;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    bodies.push(source.slice(start, index));
  }
  return bodies;
}

describe("transactions", () => {
  it("never run session operations in parallel", () => {
    const offenders = sourceFiles(path.resolve(import.meta.dirname, "..")).flatMap((file) =>
      transactionBodies(readFileSync(file, "utf8"))
        .filter((body) => /Promise\.all\([\s\S]*?session/.test(body))
        .map(() => path.relative(process.cwd(), file)),
    );
    expect(offenders).toEqual([]);
  });
});
