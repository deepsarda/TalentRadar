import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "mongodb";
import { GridFSBucket, ObjectId } from "mongodb";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import type { JobContext } from "../jobs/worker.js";
import { runCommand } from "./commands.js";

const RenderCvPayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  fileId: z.string().length(24),
});

const MAX_CV_PAGES = 3;

const injectionPattern =
  /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)|system\s*prompt|you\s+are\s+chatgpt|rate\s+(me|this)\s+(5|five)/i;

function download(bucket: GridFSBucket, fileId: ObjectId): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = bucket.openDownloadStream(fileId);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export interface CvInspection {
  pageCount: number;
  links: string[];
  possiblePromptInjection: boolean;
}

/** Reads hyperlinks and scans the hidden text layer of the first pages. The model sees neither. */
export async function inspectCvPdf(pdf: Buffer): Promise<CvInspection> {
  if (pdf.length === 0 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Stored CV is not a valid PDF");
  }
  const loadingTask = getDocument({ data: new Uint8Array(pdf), useWorkerFetch: false });
  try {
    const document = await loadingTask.promise;
    const links = new Set<string>();
    const hiddenText: string[] = [];
    const pageLimit = Math.min(document.numPages, MAX_CV_PAGES);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations(),
        page.getTextContent(),
      ]);
      for (const annotation of annotations) {
        if ("url" in annotation && typeof annotation.url === "string") links.add(annotation.url);
      }
      for (const item of textContent.items) {
        if ("str" in item && typeof item.str === "string") hiddenText.push(item.str);
      }
    }
    return {
      pageCount: document.numPages,
      links: [...links],
      possiblePromptInjection: injectionPattern.test(hiddenText.join(" ")),
    };
  } finally {
    await loadingTask.destroy();
  }
}

/** Renders the first pages to 150-DPI PNGs with poppler and returns them base64-encoded. */
export async function renderPdfPages(pdf: Buffer, signal?: AbortSignal): Promise<string[]> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "talentradar-cv-"));
  try {
    const inputPath = path.join(temporaryRoot, "input.pdf");
    const outputPrefix = path.join(temporaryRoot, "page");
    await writeFile(inputPath, pdf, { flag: "wx", mode: 0o600 });
    await runCommand(
      "pdftoppm",
      ["-f", "1", "-l", String(MAX_CV_PAGES), "-r", "150", "-png", inputPath, outputPrefix],
      { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    );
    const pages = (await readdir(temporaryRoot))
      .filter((file) => /^page-\d+\.png$/.test(file))
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(
      pages.map(async (page) =>
        (await readFile(path.join(temporaryRoot, page))).toString("base64"),
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function renderCvPages(
  db: Db,
  fileId: ObjectId,
  signal?: AbortSignal,
): Promise<string[]> {
  const pdf = await download(new GridFSBucket(db, { bucketName: "cv" }), fileId);
  return renderPdfPages(pdf, signal);
}

export function createRenderCvHandler(db: Db) {
  const bucket = new GridFSBucket(db, { bucketName: "cv" });
  return async ({ job, progress, signal }: JobContext): Promise<Record<string, unknown>> => {
    const payload = RenderCvPayloadSchema.parse(job.payload);
    const fileId = ObjectId.createFromHexString(payload.fileId);
    await progress(
      "cv.download.started",
      "Reading the submitted CV from encrypted application storage",
    );
    const pdf = await download(bucket, fileId);
    const inspection = await inspectCvPdf(pdf);
    const pageLimit = Math.min(inspection.pageCount, MAX_CV_PAGES);
    await progress(
      "cv.render.started",
      `Rendering ${pageLimit} CV page${pageLimit === 1 ? "" : "s"} at 150 DPI`,
    );
    const renderedPages = await renderPdfPages(pdf, signal);
    if (renderedPages.length !== pageLimit) {
      throw new Error(`Expected ${pageLimit} rendered CV pages, received ${renderedPages.length}`);
    }
    const { links, possiblePromptInjection } = inspection;
    await progress(
      "cv.render.completed",
      `Rendered ${renderedPages.length} pages and extracted ${links.length} link${links.length === 1 ? "" : "s"}`,
    );
    if (possiblePromptInjection) {
      await progress(
        "cv.prompt_injection.flagged",
        "The hidden CV text layer contains instruction-like text",
      );
    }
    return {
      fileId: payload.fileId,
      pageCount: inspection.pageCount,
      renderedPageCount: renderedPages.length,
      links,
      possiblePromptInjection,
    };
  };
}
