import { readFileSync } from 'node:fs';
import { textsOf } from '../../support/texts.ts';
import type { TextLookup, TextTable } from '../../support/texts.ts';

/**
 * The enterprise clip dataset writes the shared seed groups of the guide (capital, projects) in the words of the enterprise: its plan file (CLIP_PLAN_FILE) carries
 * `texts` entries named `<file>:<key>` that replace the key of the table of that file. Without a plan of the enterprise dataset nothing changes. The plan is read once.
 */
let overrides: Record<string, string> | undefined;

function overridesOfPlan(): Record<string, string> {
  if (overrides !== undefined) return overrides;
  overrides = {};
  const file = process.env.CLIP_PLAN_FILE;
  if (file === undefined || file === '') return overrides;
  try {
    const plan = JSON.parse(readFileSync(file, 'utf8')) as { dataset?: string; texts?: Record<string, string> };
    if (plan.dataset === 'enterprise' && plan.texts !== undefined) overrides = plan.texts;
  } catch {
    // an unreadable plan changes nothing
  }
  return overrides;
}

/** The lookup of a table of texts with the overrides of the enterprise plan (keys `<file>:<key>`). */
export function textsWithOverlay<T extends TextTable>(file: string, table: T): TextLookup<T> {
  const base = textsOf(table);
  return (key, ...args) => {
    const replaced = overridesOfPlan()[`${file}:${key}`];
    if (replaced === undefined) return base(key, ...args);
    return args.length === 0 ? replaced : replaced.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
  };
}
