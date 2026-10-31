import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { kindLabel } from '../labels';
import HistoryFrame from './HistoryFrame';
import { validityOf } from './model';
import type { HistoryRestrictionView } from './model';

type T = Translator['t'];

const sourceText = (t: T, restriction: HistoryRestrictionView): string => (restriction.source === 'DECISION' ? t('bid.history.source.decision') : t('bid.history.source.import'));

function validityText(t: T, restriction: HistoryRestrictionView): string {
  switch (validityOf(restriction)) {
    case 'inForce':
      return t('bid.history.validity.inForce');
    case 'ended':
      return t('bid.history.validity.ended');
    case 'upcoming':
      return t('bid.history.validity.upcoming');
  }
}

/**
 * BID-21: the restrictions on the participation of a contractor (ST-BID-013, BID 3.1 F2, BR-BID-01). Each line says its kind, where it comes from (the official file of the national system, or a decision), the first and the
 * last day it stands and, in words, whether it applies now. A restriction that applies blocks a proposal and a result (422 `CONTRACTOR_RESTRICTED`), and the screen says so above the list.
 */
export default function RestrictionsScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <HistoryFrame id={route.id} req={route.req ?? ''} title={t('bid.history.restrictions.title')} subtitle={t('bid.history.restrictions.subtitle')}>
      {(history) => (
        <>
          {history.restrictionInForce ? (
            <p className="callout warning" role="status" data-testid="blocked">
              {t('bid.history.restrictions.blocked.notice', { name: history.contractor.legalName })}
            </p>
          ) : null}
          {history.restrictions.length === 0 ? (
            <p className="callout" role="status" data-testid="none">
              {t('bid.history.restrictions.none.notice')}
            </p>
          ) : (
            <div className="tablewrap">
              <table className="table" aria-label={t('bid.history.restrictions.aria', { name: history.contractor.legalName })} data-testid="restrictions">
                <thead>
                  <tr>
                    <th scope="col">{t('bid.history.col.kind')}</th>
                    <th scope="col">{t('bid.history.col.source')}</th>
                    <th scope="col">{t('bid.history.col.from')}</th>
                    <th scope="col">{t('bid.history.col.until')}</th>
                    <th scope="col">{t('bid.history.col.validity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.restrictions.map((restriction) => (
                    <tr key={restriction.id} data-restriction={restriction.id} data-validity={validityOf(restriction)}>
                      <td>{kindLabel(t, restriction.kind)}</td>
                      <td>{sourceText(t, restriction)}</td>
                      <td>{restriction.effectiveFrom}</td>
                      <td>{restriction.effectiveUntil ?? t('bid.history.until.open')}</td>
                      <td>
                        <span className={`pill ${validityOf(restriction) === 'inForce' ? 'red' : 'gray'}`}>{validityText(t, restriction)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </HistoryFrame>
  );
}
