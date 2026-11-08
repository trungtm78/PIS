import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEvalMarkdown, summarizeEval } from '@machvon/kernel';
import type { EvalSummary, GroundedCaseResult, SafetyCaseResult } from '@machvon/kernel';

/** Where the committed report lives: docs/qa of the repository root. */
export const REPORT_DIR = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'qa');
export const REPORT_JSON = join(REPORT_DIR, 'ai-assist-eval.json');
export const REPORT_MARKDOWN = join(REPORT_DIR, 'ai-assist-eval.md');

export interface EvalReport {
  json: string;
  markdown: string;
  summary: EvalSummary;
}

/** The report as the two files: the JSON carries the summary and every case, the markdown is the same for a reader. No clock and no random value goes in, so the same behaviour gives the same bytes. */
export function buildReport(corpusVersion: number, grounded: readonly GroundedCaseResult[], safety: readonly SafetyCaseResult[]): EvalReport {
  const summary = summarizeEval(grounded, safety);
  const json = `${JSON.stringify({ report: 'ai-assist-eval', corpusVersion, summary, grounded, safety }, null, 2)}\n`;
  return { json, markdown: renderEvalMarkdown(summary, grounded, safety), summary };
}

/** Writes both files (the test does it only when AI_EVAL_WRITE=1). */
export function writeReport(report: EvalReport): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_JSON, report.json);
  writeFileSync(REPORT_MARKDOWN, report.markdown);
}

/** The files as committed, or undefined when they are not there. */
export function readCommitted(): { json: string; markdown: string } | undefined {
  try {
    return { json: readFileSync(REPORT_JSON, 'utf8'), markdown: readFileSync(REPORT_MARKDOWN, 'utf8') };
  } catch {
    return undefined;
  }
}
