import type { Translator } from '../i18n';

/**
 * The title of a screen of the installed application (`/m/...`) for the breadcrumb of the top bar. These screens are not rows of the route table, so the shell cannot find them by path and would
 * call them "screen not found"; they carry the same title as their own heading. Undefined when the address is not one of them.
 */
export function pwaTitle(t: Translator['t'], pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/m') return t('pwa.start.page.title');
  if (path === '/m/approvals') return t('pwa.approvals.page.title');
  if (/^\/m\/approvals\/[^/]+$/.test(path)) return t('pwa2.approvalDetail.page.title');
  if (path === '/m/dashboard') return t('pwa.dashboard.page.title');
  if (path === '/m/dashboard/detail') return t('pwa2.figures.page.title');
  if (path === '/m/progress') return t('pwa2.progress.page.title');
  if (path === '/m/directives') return t('pwa.directives.page.title');
  if (/^\/m\/directives\/[^/]+$/.test(path)) return t('pwa.directives.detail.title');
  if (path === '/m/settings') return t('pwa2.settings.page.title');
  if (path === '/m/notifications') return t('webpush.page.title');
  return undefined;
}
