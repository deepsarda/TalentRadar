function key(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export interface NormalizedCollege {
  value: string;
  mapped: boolean;
}

export function normalizeCollege(
  value: string,
  aliases: Readonly<Record<string, readonly string[]>>,
): NormalizedCollege {
  const cleaned = value.trim().replace(/\s+/g, " ");
  const inputKey = key(cleaned);
  for (const [canonical, alternatives] of Object.entries(aliases)) {
    if (key(canonical) === inputKey || alternatives.some((alias) => key(alias) === inputKey)) {
      return { value: canonical.trim().replace(/\s+/g, " "), mapped: true };
    }
  }
  return { value: cleaned, mapped: false };
}
