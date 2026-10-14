/** A cited file opens at the scored commit; a cited folder (stored with a trailing "/") opens as a tree. */
export function evidenceUrl(evidence: { repository: string; commitSha: string; path: string }) {
  const base = `https://github.com/${evidence.repository}`;
  // "/" is the repository root (e.g. a tool found by the detectors, not a cited file).
  if (evidence.path === "/") return `${base}/tree/${evidence.commitSha}`;
  const kind = evidence.path.endsWith("/") ? "tree" : "blob";
  return `${base}/${kind}/${evidence.commitSha}/${evidence.path}`;
}
