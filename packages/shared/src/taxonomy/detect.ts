import type { Taxonomy } from "./taxonomy.js";
import { taxonomy } from "./taxonomy.js";

export interface RepositoryDetectionInput {
  files: Record<string, string>;
  languages?: string[];
}

export interface TechnologyMatch {
  id: string;
  label: string;
  domains: string[];
  reasons: string[];
}

export interface TaxonomyIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[_.\s]+/g, "-");
}

function parseJson(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function npmPackages(files: Record<string, string>): Set<string> {
  const manifest = parseJson(files["package.json"]);
  return new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
      objectKeys(manifest?.[key]).map(normalize),
    ),
  );
}

function pythonPackages(files: Record<string, string>): Set<string> {
  const content = [files["requirements.txt"], files["pyproject.toml"]].filter(Boolean).join("\n");
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((line) => normalize(line.split(/[<>=!~\s\[]/, 1)[0] ?? "")),
  );
}

function quotedManifestNames(content: string | undefined): Set<string> {
  if (!content) return new Set();
  return new Set(
    [...content.matchAll(/["']([^"']+)["']\s*(?:=|,|\))/g)].map((match) => normalize(match[1] ?? "")),
  );
}

function jsonSectionNames(files: Record<string, string>, fileName: string, sections: string[]): Set<string> {
  const manifest = parseJson(files[fileName]);
  return new Set(sections.flatMap((section) => objectKeys(manifest?.[section]).map(normalize)));
}

export function detectTechnologies(
  input: RepositoryDetectionInput,
  selectedTaxonomy: Taxonomy = taxonomy,
): TechnologyMatch[] {
  const normalizedFiles = Object.fromEntries(
    Object.entries(input.files).map(([path, content]) => [path.replace(/^\.\//, "").toLowerCase(), content]),
  );
  const paths = Object.keys(normalizedFiles);
  const basenames = new Set(paths.map((path) => path.split("/").at(-1) ?? path));
  const corpus = Object.values(normalizedFiles).join("\n").toLowerCase();
  const ecosystems: Record<string, Set<string>> = {
    npm: npmPackages(normalizedFiles),
    pip: pythonPackages(normalizedFiles),
    cargo: quotedManifestNames(normalizedFiles["cargo.toml"]),
    // biome-ignore lint/complexity/useLiteralKeys: File maps intentionally use an index signature.
    gem: quotedManifestNames(normalizedFiles["gemfile"]),
    composer: jsonSectionNames(normalizedFiles, "composer.json", ["require", "require-dev"]),
    maven: new Set(),
    gradle: new Set(),
  };
  const languages = new Set((input.languages ?? []).map(normalize));

  return Object.entries(selectedTaxonomy.technologies).flatMap(([id, technology]) => {
    const reasons: string[] = [];
    for (const [detector, values] of Object.entries(technology.detect)) {
      for (const value of values) {
        const normalizedValue = normalize(value);
        if (detector in ecosystems && ecosystems[detector]?.has(normalizedValue)) {
          reasons.push(`${detector}:${value}`);
        } else if (detector === "language" && languages.has(normalizedValue)) {
          reasons.push(`language:${value}`);
        } else if (
          detector === "extensions" &&
          paths.some((path) => path.endsWith(value.toLowerCase()))
        ) {
          reasons.push(`extension:${value}`);
        } else if (
          detector === "files" &&
          (basenames.has(value.toLowerCase()) || paths.includes(value.toLowerCase()))
        ) {
          reasons.push(`file:${value}`);
        } else if (
          detector === "paths" &&
          paths.some((path) => path.includes(value.toLowerCase().replaceAll("*", "")))
        ) {
          reasons.push(`path:${value}`);
        } else if (["maven", "gradle", "commands", "imports", "links", "api", "concepts", "sdk", "runtime"].includes(detector) && corpus.includes(value.toLowerCase())) {
          reasons.push(`${detector}:${value}`);
        }
      }
    }
    return reasons.length > 0 ? [{ id, label: technology.label, domains: technology.domains, reasons }] : [];
  });
}

export function validateTaxonomy(selectedTaxonomy: Taxonomy = taxonomy): TaxonomyIssue[] {
  const issues: TaxonomyIssue[] = [];
  const aliases = new Map<string, string>();
  const detectors = new Map<string, Set<string>>();

  for (const [id, technology] of Object.entries(selectedTaxonomy.technologies)) {
    for (const domain of technology.domains) {
      if (!selectedTaxonomy.domains[domain]) {
        issues.push({
          severity: "error",
          code: "unknown_domain",
          message: `${id} references unknown domain ${domain}`,
        });
      }
    }
    for (const alias of [id, ...technology.aliases]) {
      const key = normalize(alias);
      const owner = aliases.get(key);
      if (owner && owner !== id) {
        issues.push({
          severity: "error",
          code: "duplicate_alias",
          message: `${alias} is shared by ${owner} and ${id}`,
        });
      } else {
        aliases.set(key, id);
      }
    }
    for (const [detector, values] of Object.entries(technology.detect)) {
      if (values.length === 0) {
        issues.push({
          severity: "error",
          code: "empty_detector",
          message: `${id} has an empty ${detector} detector`,
        });
      }
      for (const value of values) {
        const key = `${detector}:${normalize(value)}`;
        const owners = detectors.get(key) ?? new Set<string>();
        owners.add(id);
        detectors.set(key, owners);
      }
    }
  }

  for (const [detector, owners] of detectors) {
    if (owners.size > 1) {
      issues.push({
        severity: "warning",
        code: "detector_conflict",
        message: `${detector} matches ${[...owners].sort().join(", ")}`,
      });
    }
  }
  return issues;
}
