import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Details the onboarding form can prefill. A field is present only when the CV states it. */
export interface CvDetails {
  name?: string;
  college?: string;
  year?: string;
  branch?: string;
}

const institutionPattern =
  /\b(university|institute|college|vidyapeeth|vidyalaya|iit|nit|iiit|bits|polytechnic)\b/i;
const degreePattern =
  /\b(b\.?\s?tech|b\.?\s?e\.?|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|b\.?\s?ca|m\.?\s?ca|bachelor|master|dual degree|integrated)\b/i;
// Only branches written out in full: an abbreviation like "CSE" is ambiguous enough to be a guess.
const branchPattern =
  /\b(computer science(?: (?:and|&) (?:engineering|design|business systems))?|information technology|electronics (?:and|&) (?:communication|instrumentation|telecommunication)(?: engineering)?|electrical (?:and|&) electronics engineering|electrical engineering|mechanical engineering|civil engineering|chemical engineering|artificial intelligence(?: (?:and|&) (?:machine learning|data science))?|data science|mathematics (?:and|&) computing|engineering physics|biotechnology|production engineering|metallurgical (?:and|&) materials engineering|aerospace engineering)\b/i;
const ordinalYears: Record<string, string> = {
  first: "1",
  "1st": "1",
  second: "2",
  "2nd": "2",
  third: "3",
  "3rd": "3",
  fourth: "4",
  "4th": "4",
  fifth: "5+",
  "5th": "5+",
};
const yearPattern = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)[\s-]+year\b/i;
const nameStopWords =
  /\b(resume|résumé|curriculum|vitae|cv|profile|email|phone|linkedin|github|summary|objective|education|experience)\b/i;

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase());
}

/**
 * Pulls name, college, year of study and branch out of CV text. Deliberately conservative: each
 * field comes from an explicit statement (a heading-like name line, a line naming an institution,
 * "third year", a written-out branch on a degree line). Anything else stays empty for the person
 * to type, because a wrong prefill is worse than none.
 */
export function extractCvDetails(text: string): CvDetails {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const details: CvDetails = {};

  // The name is the first line of a CV by convention; accept it only if it looks like one.
  const first = lines[0];
  if (
    first &&
    !nameStopWords.test(first) &&
    /^\p{L}[\p{L}.'-]*(?: \p{L}[\p{L}.'-]*){1,3}$/u.test(first) &&
    first.split(" ").every((word) => /^\p{Lu}/u.test(word))
  ) {
    details.name = first === first.toUpperCase() ? titleCase(first) : first;
  }

  for (const line of lines) {
    if (!details.college && institutionPattern.test(line)) {
      // Lines often read "Institute, City | 2022 – 2026 | CGPA 8.9": keep the institution part.
      const part = line
        .split(/\s[|•·–—]\s|\s{2,}|\t/)
        .find((segment) => institutionPattern.test(segment));
      const college = part
        ?.replace(/,?\s*\b(19|20)\d{2}\b.*$/, "")
        .replace(/[,;:\s]+$/, "")
        .trim();
      if (college && college.length >= 3 && college.length <= 200) details.college = college;
    }
    if (!details.branch && degreePattern.test(line)) {
      const branch = line.match(branchPattern)?.[0];
      if (branch) details.branch = titleCase(branch).replace(/\bAnd\b/g, "and");
    }
    if (!details.year) {
      const ordinal = line.match(yearPattern)?.[1]?.toLowerCase();
      const year = ordinal ? ordinalYears[ordinal] : undefined;
      if (year) details.year = year;
    }
  }
  return details;
}

/** The text layer of the first two pages, one line per visual line. */
export async function pdfText(pdf: Buffer): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(pdf), useWorkerFetch: false });
  try {
    const document = await loadingTask.promise;
    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 2); pageNumber += 1) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      let line = "";
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && typeof y === "number" && Math.abs(y - lastY) > 2) {
          lines.push(line);
          line = "";
        }
        line += item.str;
        if (typeof y === "number") lastY = y;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      lines.push(line);
    }
    return lines.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}
