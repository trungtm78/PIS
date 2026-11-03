import { useTranslation } from '../../../i18n';
import { signedAmountText } from '../change/model';
import { amountText } from '../model';
import type { AdjustmentRecord } from '../model';
import '../ctr.css';

/** A signed difference of money as the person reads it: the sign is always written, so a rise and a fall are not told apart by a colour. */
export function signedMoney(amount: string, locale: string): string {
  const shown = signedAmountText(amount, locale) ?? amount;
  return shown.startsWith('-') || shown === '0' ? shown : `+${shown}`;
}

/**
 * What a retroactive adjustment did (ST-CTR-016): the day it reaches back to, the words it rests on, and for each acceptance it re-priced the item, what the line was accepted for and what it is
 * worth at the new price. The acceptances themselves are as they were approved; the difference is an entry of the ledger.
 */
export function AdjustmentView({ record, locale }: { record: AdjustmentRecord; locale: string }) {
  const { t } = useTranslation();
  return (
    <div className="ctr-adjustment" data-adjustment={record.id}>
      <dl className="ctr-facts">
        <dt>{t('ctr.retro.history.effective')}</dt>
        <dd data-testid="adjustment-effective">{record.effectiveOn}</dd>
        <dt>{t('ctr.retro.history.basis')}</dt>
        <dd data-testid="adjustment-basis">{record.basis}</dd>
        <dt>{t('ctr.retro.history.total')}</dt>
        <dd data-testid="adjustment-total">{t('ctr.value.amount', { amount: signedMoney(record.totalDeltaVnd, locale) })}</dd>
      </dl>
      {record.affected.length === 0 ? (
        <p className="sub" data-testid="adjustment-none">
          {t('ctr.retro.history.none')}
        </p>
      ) : (
        <table className="table" data-testid="adjustment-lines">
          <thead>
            <tr>
              <th scope="col">{t('ctr.retro.history.acceptance')}</th>
              <th scope="col">{t('ctr.retro.history.item')}</th>
              <th scope="col" className="ctr-amount">
                {t('ctr.retro.history.old')}
              </th>
              <th scope="col" className="ctr-amount">
                {t('ctr.retro.history.new')}
              </th>
              <th scope="col" className="ctr-amount">
                {t('ctr.retro.history.delta')}
              </th>
            </tr>
          </thead>
          <tbody>
            {record.affected.map((line) => (
              <tr key={line.id} data-acceptance={line.acceptanceId}>
                <th scope="row">{line.acceptanceNo ?? line.acceptanceId}</th>
                <td>{line.boqItemKey}</td>
                <td className="ctr-amount">{amountText(line.oldAmountVnd, locale)}</td>
                <td className="ctr-amount">{amountText(line.newAmountVnd, locale)}</td>
                <td className="ctr-amount" data-testid="line-delta">
                  {signedMoney(line.deltaVnd, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
