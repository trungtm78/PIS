import type { PushWords } from './push-payload';

/**
 * The words of the worker, in the languages of the product. A worker has no catalogue (the catalogue is megabytes and a worker starts on every push), so
 * the sentence it owns is here: the title is the name of the product and the sentence tells that something is waiting and nothing about what.
 */
const TEXTS: Readonly<Record<'vi' | 'en', PushWords>> = {
  vi: { appName: 'Hệ thống quản lý đầu tư công', body: 'Bạn có một thông báo mới. Mở để xem.' },
  en: { appName: 'Public Investment Management System', body: 'You have a new notification. Open to read it.' },
};

export function pushWordsFor(language: string | undefined, appName?: string): PushWords {
  const base = language !== undefined && language.toLowerCase().startsWith('en') ? TEXTS.en : TEXTS.vi;
  return { appName: appName !== undefined && appName !== '' ? appName : base.appName, body: base.body };
}
