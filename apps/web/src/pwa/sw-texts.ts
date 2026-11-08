import type { PushWords } from './push-payload';
import texts from './sw-texts.json';

/**
 * The words of the worker, in the languages of the product. A worker has no catalogue (the catalogue is megabytes and a worker starts on every push), so
 * the sentence it owns is here: the title is the name of the product and the sentence tells that something is waiting and nothing about what.
 */
const TEXTS: Readonly<Record<'vi' | 'en', PushWords>> = texts;

export function pushWordsFor(language: string | undefined, appName?: string): PushWords {
  const base = language !== undefined && language.toLowerCase().startsWith('en') ? TEXTS.en : TEXTS.vi;
  return { appName: appName !== undefined && appName !== '' ? appName : base.appName, body: base.body };
}
