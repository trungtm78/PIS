import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioIndex, Flow } from './recorder.ts';

/** What the browser found on a screen: the words the narration is made from. */
export interface Facts {
  labels: string[];
  buttons: string[];
  rows: number;
  empty: boolean;
  denied: boolean;
  /** The screen waits for a record to be chosen ("open the project from the list"). */
  needsRecord?: boolean;
}

export interface CatalogueScreen {
  id: string;
  title: string;
  kind: string;
  module: string;
  moduleName: string;
  role: string;
  rule: string;
  fields: string[];
}

export interface TourChapter {
  id: string;
  kind: 'tour' | 'flow';
  module: string;
  group: string;
  title: string;
  screens: string[];
}

interface Narration {
  composeTour(chapter: TourChapter, screens: CatalogueScreen[], facts: Map<string, Facts>): Flow;
}

interface Voice {
  narrate(flowId: string, options?: { root?: string }): { steps: AudioIndex['steps'] };
}

const scripts = (name: string): string => pathToFileURL(join(process.cwd(), '..', '..', 'scripts', 'hdsd', name)).href;

// The tooling of the guide is plain JavaScript modules in scripts/hdsd: they are loaded when needed, with the shape the recording relies on.
export async function narration(): Promise<Narration> {
  return (await import(scripts('narration.mjs'))) as Narration;
}

export async function voice(): Promise<Voice> {
  return (await import(scripts('tts.mjs'))) as Voice;
}
