import { taxonomy } from "@talentradar/shared";

export function skillLabel(id: string): string {
  return taxonomy.technologies[id]?.label ?? taxonomy.domains[id]?.label ?? id;
}

/** Every taxonomy id an organizer can require, alphabetical. */
export const skillOptions = [
  ...Object.entries(taxonomy.domains).map(([id, domain]) => ({
    id,
    label: domain.label,
  })),
  ...Object.entries(taxonomy.technologies).map(([id, technology]) => ({
    id,
    label: technology.label,
  })),
].sort((left, right) => left.label.localeCompare(right.label));

/** Areas are what organizers ask for (taxonomy domains); tools are what code reveals. */
export function isArea(id: string): boolean {
  return id in taxonomy.domains;
}

/** Split any skill-keyed list into areas then tools, dropping empty groups. Order within a group is kept. */
export function splitSkills<T>(items: readonly T[], idOf: (item: T) => string) {
  return [
    { label: "areas", items: items.filter((item) => isArea(idOf(item))) },
    { label: "tools", items: items.filter((item) => !isArea(idOf(item))) },
  ].filter((group) => group.items.length > 0);
}
