import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { usePermitTypes } from './hooks';
import { groupTypes, vietnamToday } from './model';
import { WaiverGrantForm } from './WaiverGrantForm';
import { FilterPanel } from '../../ui';
import { WaiversTable } from './WaiversTable';
import { useWaivers } from './waiver-hooks';
import { waiverStatusLabel } from './waiver-labels';
import { EMPTY_WAIVER_FILTER, WAIVER_STATUSES, WAIVE_PERMISSION, filterWaivers } from './waiver-model';
import type { WaiverFilter, WaiverStatus } from './waiver-model';
import './pmt.css';

// A tenant without a waiver yet still has the form to grant the first: that is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/**
 * PMT-06: the time-limited waivers of the permit gates. The leader in charge lets a gate pass without a permit of one type until a last day within the
 * longest a waiver may last, on a decision document and for a reason, and not when they are one of the people who asked for it; a waiver in force can
 * be revoked with the words that explain it. The exemption of a permit itself is made on the permit (PMT-02) and is not repeated here.
 */
export default function PermitWaiverScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The waivers shown are those of the projects in the scope of the membership: a switch starts the screen over.
  return <PermitWaiverContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PermitWaiverContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const today = vietnamToday();
  const waivers = useWaivers();
  const types = usePermitTypes();
  const [filter, setFilter] = useState<WaiverFilter>(EMPTY_WAIVER_FILTER);
  const state = useScreenState({ isLoading: waivers.isLoading, error: waivers.error, data: waivers.data, isEmpty: NEVER_EMPTY });
  const mayWaive = (permissions === undefined || permissions.includes(WAIVE_PERMISSION)) && mode !== 'READ_ONLY';
  const groups = useMemo(() => groupTypes(types.data ?? [], today).filter((group) => group.current.status !== 'DRAFT'), [types.data, today]);
  const shown = useMemo(() => filterWaivers(waivers.data ?? [], filter), [waivers.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.waiver.page.title')}</h1>
          <p>{t('pmt.waiver.page.subtitle')}</p>
          <p className="sub">
            {t('pmt.waiver.page.exemption.text')} <Link to="/pmt/pmt-01">{t('pmt.waiver.page.exemption.link')}</Link>
          </p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void waivers.refetch()}>
        <div className="stack">
          <FilterPanel applied={filter.status === '' ? 0 : 1}>
            <form className="cap-filters" role="search" aria-label={t('pmt.waiver.filters.title')} onSubmit={(event) => event.preventDefault()}>
              <Field id="waiver-status-filter" label={t('pmt.waiver.filters.status.label')} error={undefined}>
                <select id="waiver-status-filter" value={filter.status} onChange={(event) => setFilter({ status: event.target.value as WaiverStatus | '' })}>
                  <option value="">{t('pmt.waiver.filters.status.all')}</option>
                  {WAIVER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {waiverStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </Field>
            </form>
          </FilterPanel>
          <div className="card">
            {shown.length === 0 ? (
              <p className="sub" data-testid="empty-waivers">
                {t('pmt.waiver.empty.text')}
              </p>
            ) : (
              <WaiversTable waivers={shown} today={today} mayRevoke={mayWaive} />
            )}
          </div>
          {mayWaive ? <WaiverGrantForm today={today} types={groups} /> : <p className="sub">{t('pmt.waiver.readonly.text')}</p>}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('pmt.waiver.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
