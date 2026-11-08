import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { useCases } from '../shared/vnd-hooks';
import { caseStatusLabel, groupLabel, scopeLabel } from '../shared/vnd-labels';
import { CASE_STATUSES, PATHS, PERMISSION, caseStatusTone, dayText, isUuid, numberText } from '../shared/vnd-model';
import type { CaseLine, Policy } from '../shared/vnd-model';
import { ClockCell, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import CaseDetailView from './CaseDetail';
import { OpenCaseDialog, OpenFromEgpDialog } from './case-dialogs';

/**
 * VND-03, the debarment cases. Without a case in the address it is the list: the cases by status, the clock of the decision (15 days from the proposal by the rule, not verified) and the counts; with `?case=` it is the case itself.
 * A case is opened from a proposal or from a restriction record of the national network (BID-24); the steps of the case are on its own view.
 */
export default function CasesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const id = useIdParam('case', 'id');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (id !== undefined) return <CaseDetailView key={`${scope}:${id}`} route={route} id={id} />;
  return <CaseList key={scope} route={route} />;
}

interface Filters {
  status: string;
  open: boolean;
  contractor: string;
}

function CaseList({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const writer = useWriter();
  const navigate = useNavigate();
  const fromAddress = useIdParam('contractor') ?? '';
  const [draft, setDraft] = useState<Filters>({ status: '', open: false, contractor: fromAddress });
  const [filters, setFilters] = useState<Filters>({ status: '', open: false, contractor: fromAddress });
  const [dialog, setDialog] = useState<'open' | 'egp' | undefined>(undefined);
  const receipt = useReceipt();
  const contractorOk = filters.contractor === '' || isUuid(filters.contractor);
  const query = useCases({ ...filters, contractor: contractorOk ? filters.contractor.trim() : '' });
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const canPropose = writer.can(PERMISSION.restrictionPropose);
  const applied = [filters.status !== '', filters.open, filters.contractor !== ''].filter(Boolean).length;

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setFilters({ ...draft, contractor: draft.contractor.trim() });
  };
  const clear = (): void => {
    setDraft({ status: '', open: false, contractor: '' });
    setFilters({ status: '', open: false, contractor: '' });
  };
  const opened = (caseId: string | undefined): void => {
    setDialog(undefined);
    receipt.show(t('vnd.cases.receipt.opened.text'));
    if (caseId !== undefined) navigate(PATHS.caseOf(caseId));
  };

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.cases.page.title')}
        subtitle={t('vnd.cases.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          canPropose ? (
            <>
              <button type="button" className="ui-button ui-button--outline" data-testid="open-egp-case" onClick={() => setDialog('egp')}>
                {t('vnd.cases.egp.action')}
              </button>
              <button type="button" className="ui-button ui-button--primary" data-testid="open-case" onClick={() => setDialog('open')}>
                {t('vnd.cases.open.action')}
              </button>
            </>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <FilterPanel applied={applied} {...(data === undefined ? {} : { updatedAt: dayText(data.as_of) })}>
        <form className="vnd-filters" onSubmit={apply} aria-label={t('vnd.cases.filters.label')}>
          <label>
            {t('vnd.cases.filter.status.label')}
            <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              <option value="">{t('vnd.register.filter.any.option')}</option>
              {CASE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {caseStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('vnd.cases.filter.contractor.label')}
            <input type="text" autoComplete="off" value={draft.contractor} onChange={(event) => setDraft({ ...draft, contractor: event.target.value })} />
          </label>
          <label className="vnd-filter-check">
            <input type="checkbox" checked={draft.open} onChange={(event) => setDraft({ ...draft, open: event.target.checked })} />
            {t('vnd.cases.filter.open.label')}
          </label>
          <span className="vnd-row">
            <button type="submit" className="ui-button ui-button--primary">
              {t('vnd.register.filter.apply.action')}
            </button>
            <button type="button" className="ui-button ui-button--outline" onClick={clear}>
              {t('vnd.register.filter.clear.action')}
            </button>
          </span>
        </form>
        {!contractorOk && (
          <p className="callout" role="alert" data-testid="contractor-filter-error">
            {t('vnd.field.uuid.text')}
          </p>
        )}
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="vnd-page">
            <KpiStrip label={t('vnd.cases.counts.label')}>
              <KpiTile label={t('vnd.cases.counts.open.name')} value={numberText(data.counts.open, locale)} sub={<CountSub policy={data.policy} text={t('vnd.cases.counts.open.sub')} />} />
              <KpiTile
                label={t('vnd.cases.counts.overdue.name')}
                value={numberText(data.counts.overdue, locale)}
                tone={data.counts.overdue > 0 ? 'danger' : 'default'}
                sub={<CountSub policy={data.policy} text={t('vnd.cases.counts.overdue.sub')} />}
              />
              <KpiTile label={t('vnd.cases.counts.inTime.name')} value={numberText(data.counts.decided_in_time, locale)} sub={<CountSub policy={data.policy} text={t('vnd.cases.counts.inTime.sub')} />} />
              <KpiTile
                label={t('vnd.cases.counts.late.name')}
                value={numberText(data.counts.decided_late, locale)}
                tone={data.counts.decided_late > 0 ? 'warning' : 'default'}
                sub={<CountSub policy={data.policy} text={t('vnd.cases.counts.late.sub')} />}
              />
            </KpiStrip>
            <SectionCard title={t('vnd.cases.section.list.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
              <DataTable<CaseLine>
                caption={t('vnd.cases.table.caption')}
                rows={data.items}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-case-id': row.id })}
                state={data.items.length === 0 ? 'empty' : 'ready'}
                emptyKind={applied > 0 ? 'filtered' : 'none'}
                onClearFilters={clear}
                severity={(row) => (row.clock === 'OVERDUE' ? 'URGENT' : row.clock === 'DUE_SOON' ? 'ACTION' : null)}
                columns={[
                  { key: 'no', header: t('vnd.cases.column.no'), pinned: true, render: (row) => <Link to={PATHS.caseOf(row.id)}>{row.case_no}</Link> },
                  {
                    key: 'subject',
                    header: t('vnd.cases.column.subject'),
                    render: (row) => (
                      <span className="vnd-stack">
                        <span>{row.subject_name}</span>
                        <span className="vnd-days">{row.subject_kind === 'JOINT_VENTURE' ? t('vnd.subject.jointVenture.name') : t('vnd.subject.contractor.name')}</span>
                      </span>
                    ),
                  },
                  { key: 'groups', header: t('vnd.cases.column.groups'), render: (row) => row.violation_groups.map((group) => groupLabel(t, group)).join(', ') },
                  { key: 'status', header: t('vnd.cases.column.status'), render: (row) => <StatusPill tone={caseStatusTone(row.status)}>{caseStatusLabel(t, row.status)}</StatusPill> },
                  { key: 'clock', header: t('vnd.cases.column.clock'), render: (row) => <ClockCell clock={row.clock} dueAt={row.decide_by} asOf={data.as_of} /> },
                  {
                    key: 'decision',
                    header: t('vnd.cases.column.decision'),
                    render: (row) =>
                      row.decision === 'BAN' ? (
                        <span className="vnd-stack">
                          <span>{t('vnd.cases.decision.months.text', { months: row.ban_months ?? 0 })}</span>
                          {row.decision_scope !== null && <span className="vnd-days">{scopeLabel(t, row.decision_scope)}</span>}
                        </span>
                      ) : row.decision === 'DISMISS' ? (
                        t('vnd.cases.decision.dismiss.name')
                      ) : (
                        t('vnd.cases.decision.none.text')
                      ),
                  },
                ]}
              />
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      {dialog === 'open' && <OpenCaseDialog initialContractor={isUuid(fromAddress) ? fromAddress : ''} onClose={() => setDialog(undefined)} onDone={opened} />}
      {dialog === 'egp' && <OpenFromEgpDialog onClose={() => setDialog(undefined)} onDone={opened} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** The "i" of a count: the policy of the debarment rule says how the days are counted and that the number of days is not verified against the Gazette. */
function CountSub({ policy, text }: { policy: Policy; text: string }) {
  const { t } = useTranslation();
  return (
    <span className="vnd-row">
      <span>{text}</span>
      <PolicyInfo name={t('vnd.cases.figure.clock.name')} policy={policy} />
    </span>
  );
}
