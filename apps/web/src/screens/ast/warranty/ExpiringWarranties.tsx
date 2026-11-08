import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { InfoFormula } from '../../../ui';
import { useInfoLabels } from '../../gov11/gov11-kit';
import { daysLeft, toWarrantyList, vietnamToday } from './model';
import type { WarrantyLine } from './model';

const WINDOWS = ['30', '60', '90', '180', '365'] as const;
const PAGE = 50;

/** The active obligations whose warranty ends within the days asked, the soonest first (`listExpiringWarranties`); the window is part of the key. */
function useExpiring(withinDays: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<{ lines: WarrantyLine[]; hasMore: boolean }>({
    queryKey: ['ast-warranty', tenant?.id, tenant?.membershipId, 'expiring', withinDays],
    queryFn: async () => {
      const raw = await client.read('listExpiringWarranties', { query: { within_days: withinDays, limit: String(PAGE) } } as never);
      const lines = toWarrantyList(raw);
      return { lines, hasMore: typeof (raw as { next_cursor?: unknown } | undefined)?.next_cursor === 'string' };
    },
    enabled: tenant?.id !== undefined,
    retry: false,
  });
}

/**
 * The warranties that end soon, across the handovers in the scope: what is about to run out, how many days are left and how many claims are open, so that the retention and the guarantee are released on time or the claims are
 * settled first. The days left are counted from today in the Vietnam calendar to the last day of the warranty.
 */
export function ExpiringWarranties() {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  const [within, setWithin] = useState<string>('90');
  const query = useExpiring(within);
  const today = vietnamToday();
  const name = t('ast.warranty.expiring.left');
  return (
    <section className="card" aria-labelledby="expiring-title" data-testid="expiring">
      <h2 id="expiring-title">{t('ast.warranty.expiring.title')}</h2>
      <div className="field">
        <label htmlFor="expiring-window">{t('ast.warranty.expiring.window')}</label>
        <select id="expiring-window" value={within} onChange={(event) => setWithin(event.target.value)} data-testid="expiring-window">
          {WINDOWS.map((days) => (
            <option key={days} value={days}>
              {t('ast.warranty.expiring.days', { days })}
            </option>
          ))}
        </select>
      </div>
      {query.isLoading ? (
        <p role="status" aria-busy="true" data-testid="expiring-loading">
          {t('ast.warranty.expiring.loading')}
        </p>
      ) : query.isError || query.data === undefined ? (
        <p role="alert" data-testid="expiring-error">
          {t('ast.warranty.expiring.error')}{' '}
          <button type="button" onClick={() => void query.refetch()}>
            {t('ast.warranty.expiring.retry')}
          </button>
        </p>
      ) : query.data.lines.length === 0 ? (
        <p className="callout" role="status" data-testid="expiring-empty">
          {t('ast.warranty.expiring.empty', { days: within })}
        </p>
      ) : (
        <>
          <table className="table" data-testid="expiring-table">
            <caption>{t('ast.warranty.expiring.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ast.warranty.expiring.scope')}</th>
                <th scope="col">{t('ast.warranty.expiring.handover')}</th>
                <th scope="col">{t('ast.warranty.expiring.ends')}</th>
                <th scope="col">{name}</th>
                <th scope="col">{t('ast.warranty.expiring.claims')}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.lines.map((line) => (
                <tr key={line.id} data-testid={`expiring-${line.id}`}>
                  <th scope="row">{line.scope}</th>
                  <td>{`${line.handover.handoverNo ?? ''} · ${line.contract.code}`}</td>
                  <td>{line.endsOn}</td>
                  <td>
                    <span data-testid={`expiring-left-${line.id}`}>{daysLeft(line.endsOn, today)}</span>{' '}
                    <InfoFormula name={name} formula={t('ast.warranty.expiring.formula')} source={t('ast.warranty.expiring.source')} asOf={today} owner={t('ast.warranty.expiring.owner')} version={t('ast.warranty.expiring.version')} unverified={line.rule?.awaitingConfirmation === true} labels={labels(name)} />
                  </td>
                  <td>{t('ast.warranty.claims.count', { open: line.openClaims, total: line.totalClaims })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data.hasMore ? (
            <p className="sub" data-testid="expiring-more">
              {t('ast.warranty.expiring.more', { count: PAGE })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
