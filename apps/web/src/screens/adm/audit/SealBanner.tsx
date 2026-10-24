import { useTranslation } from '../../../i18n';
import { sealReasonLabel } from './labels';
import type { SealView } from './model';

/** One instant in the locale of the screen. */
export function instantText(locale: string, instant: string | null): string {
  if (instant === null) return '';
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/**
 * The verdict of the seal verification above the trail (AC-ST-ADM-016-3). A chain that does not verify interrupts as an alert; a
 * verifier that has not run or has stopped is a warning; only a verdict that is both fresh and clean is quiet.
 */
export function SealBanner({ seal }: { seal: SealView }) {
  const { t, locale } = useTranslation();
  switch (seal.status) {
    case 'BROKEN':
      return (
        <div className="callout warning sealbroken" role="alert" data-seal="BROKEN">
          <strong>{t('adm.audit.seal.broken.title')}</strong>
          <p>{t('adm.audit.seal.broken.body')}</p>
          {seal.broken === null ? null : (
            <p data-testid="seal-window">
              {t('adm.audit.seal.broken.window', { from: seal.broken.fromSeq, to: seal.broken.toSeq, reason: sealReasonLabel(t, seal.broken.reason) })}
            </p>
          )}
        </div>
      );
    case 'STALE':
      return (
        <div className="callout warning" role="status" data-seal="STALE">
          {t('adm.audit.seal.stale.text', { at: instantText(locale, seal.checkedAt) })}
        </div>
      );
    case 'UNKNOWN':
      return (
        <div className="callout warning" role="status" data-seal="UNKNOWN">
          {t('adm.audit.seal.unknown.text')}
        </div>
      );
    case 'OK':
      return (
        <div className="callout" role="status" data-seal="OK">
          {t('adm.audit.seal.ok.text', { seals: seal.seals ?? 0, at: instantText(locale, seal.checkedAt) })}
        </div>
      );
  }
}
