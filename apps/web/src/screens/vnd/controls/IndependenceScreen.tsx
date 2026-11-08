import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText, failureStatus, isUuid, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Empty, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, WithInfo, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { CONTROLS_PATHS, PERMISSION_A, decisionLabel, findingKindLabel, interestKindLabel, moneyText, strengthLabel } from './controls-model';
import type { IndependenceFinding, PackageControls, PersonInterest } from './controls-model';
import { useIndependence, useInterests, usePackageControls } from './controls-hooks';
import { ControlsDialog, DeclareInterestDialog, DecideDialog, EndInterestDialog, RunCheckDialog } from './independence-dialogs';

const NONE = '–';

type Dialog = { kind: 'run' } | { kind: 'decide'; finding: IndependenceFinding } | { kind: 'declare' } | { kind: 'end'; interest: PersonInterest } | { kind: 'controls'; controls: PackageControls };

/**
 * VND-07, the controls of a package: whether the bidders, the people who evaluate them and the owner are independent of one another. A check compares the profiles of the bidders (their keys, never the personal values)
 * with the panel and the staff named, and with what each member declared about themselves; every finding is a signal for a person to decide (clear it, take the person off the panel, or block the bidder), another
 * person than the one who ran the check. The page also holds what the package asks of its bidders (the bid security, the days the bids are valid, the value) and the declarations of interest.
 */
export default function IndependenceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const packageId = useIdParam('package', 'id');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (packageId === undefined || !isUuid(packageId)) return <PackagePicker key={scope} route={route} />;
  return <PackageControlsView key={`${scope}:${packageId}`} route={route} packageId={packageId} />;
}

function PackagePicker({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const valid = isUuid(value);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) navigate(CONTROLS_PATHS.package(value.trim()));
  };
  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.controls.page.title')} subtitle={t('vnd.controls.page.subtitle')} />
      <SectionCard title={t('vnd.controls.pick.title')}>
        <form onSubmit={submit} className="vnd-row" data-testid="package-picker">
          <label className="vnd-field">
            <span>{t('vnd.controls.pick.label')}</span>
            <input type="text" value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={value !== '' && !valid} />
          </label>
          <button type="submit" className="ui-button ui-button--primary" disabled={!valid}>
            {t('vnd.controls.pick.action')}
          </button>
        </form>
        <Empty text={t('vnd.controls.pick.empty.text')} testId="pick-empty" />
      </SectionCard>
      <ScreenFooter route={route} />
    </Screen>
  );
}

function PackageControlsView({ route, packageId }: ScreenProps & { packageId: string }) {
  const { t, locale } = useTranslation();
  const writer = useWriter();
  const query = useIndependence(packageId);
  const controls = usePackageControls(packageId);
  const { permissions } = useSession();
  const interests = useInterests(permissions?.includes(PERMISSION_A.independenceRead) === true);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const view = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: () => false });
  const state: ScreenState = view === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && view !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const mayRun = writer.can(PERMISSION_A.independenceRun);
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.controls.page.title')}
        subtitle={t('vnd.controls.page.package.text', { id: packageId.slice(0, 8) })}
        asOf={view?.as_of}
        stale={refreshFailed}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={CONTROLS_PATHS.package()}>
              {t('vnd.controls.pick.another')}
            </Link>
            {writer.can(PERMISSION_A.interestDeclare) && (
              <button type="button" className="ui-button ui-button--outline" data-testid="declare-interest" onClick={() => setDialog({ kind: 'declare' })}>
                {t('vnd.controls.interest.action')}
              </button>
            )}
            {mayRun && (
              <button type="button" className="ui-button ui-button--primary" data-testid="run-check" onClick={() => setDialog({ kind: 'run' })}>
                {t('vnd.controls.run.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view !== undefined && (
          <div className="vnd-page">
            <GateCard view={view} />
            <FindingsCard view={view} packageId={packageId} canDecide={writer.can(PERMISSION_A.independenceDecide)} onDecide={(finding) => setDialog({ kind: 'decide', finding })} />
            <ControlsCard query={controls} canSet={writer.can(PERMISSION_A.packageControls)} onSet={(value) => setDialog({ kind: 'controls', controls: value })} locale={locale} />
            <InterestsCard query={interests} canDeclare={writer.can(PERMISSION_A.interestDeclare)} canEnd={!writer.readOnly} onEnd={(interest) => setDialog({ kind: 'end', interest })} />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'run' && <RunCheckDialog packageId={packageId} packageLabel={packageId} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.controls.run.title'))} />}
      {dialog?.kind === 'decide' && <DecideDialog finding={dialog.finding} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.controls.decide.title'))} />}
      {dialog?.kind === 'declare' && <DeclareInterestDialog onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.controls.interest.title'))} />}
      {dialog?.kind === 'end' && <EndInterestDialog interest={dialog.interest} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.controls.interest.end.title'))} />}
      {dialog?.kind === 'controls' && <ControlsDialog controls={dialog.controls} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.controls.package.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** Whether the award of the package may go on, and why not: findings blocked, strong findings nobody decided. A package never checked is not blocked, and says so. */
function GateCard({ view }: { view: NonNullable<ReturnType<typeof useIndependence>['data']> }) {
  const { t } = useTranslation();
  const gate = view.gate;
  const check = view.check as { run_at: string; run_by: string; rule_version: string; rule_unverified: boolean; bidders_count: number; findings_count: number; strong_count: number } | null;
  return (
    <SectionCard title={t('vnd.controls.gate.title')} status={view.policy.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note vnd-row" data-testid="gate-banner">
        {!gate.checked ? (
          <StatusPill tone="neutral" icon="○">
            {t('vnd.controls.gate.never')}
          </StatusPill>
        ) : gate.open ? (
          <StatusPill tone="success" icon="✓">
            {t('vnd.controls.gate.open')}
          </StatusPill>
        ) : (
          <StatusPill tone="danger" icon="✕">
            {t('vnd.controls.gate.closed')}
          </StatusPill>
        )}
        <span>{t('vnd.controls.gate.rule.text')}</span>
        <PolicyInfo name={t('vnd.controls.figure.gate.name')} policy={view.policy} />
      </p>
      {gate.checked && (
        <dl className="vnd-facts" data-testid="gate-counts">
          <GateFact label={t('vnd.controls.gate.blocked')} value={gate.blocked} view={view} testId="blocked" />
          <GateFact label={t('vnd.controls.gate.undecidedStrong')} value={gate.undecided_strong} view={view} testId="undecided-strong" />
          <GateFact label={t('vnd.controls.gate.undecided')} value={gate.undecided} view={view} testId="undecided" />
          <GateFact label={t('vnd.controls.gate.cleared')} value={gate.cleared} view={view} testId="cleared" />
          <GateFact label={t('vnd.controls.gate.recused')} value={gate.recused} view={view} testId="recused" />
        </dl>
      )}
      {check !== null && (
        <p className="vnd-note" data-testid="check-summary">
          {t('vnd.controls.check.summary.text', { time: vietnamStamp(check.run_at), bidders: check.bidders_count, findings: check.findings_count, strong: check.strong_count, version: check.rule_version })}
        </p>
      )}
    </SectionCard>
  );
}

function GateFact({ label, value, view, testId }: { label: string; value: number; view: NonNullable<ReturnType<typeof useIndependence>['data']>; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="vnd-fact" data-testid={`gate-${testId}`}>
      <dt>
        <WithInfo info={<CountInfo name={label} formula={t('vnd.controls.gate.formula.text')} source={t('vnd.controls.gate.source.text')} asOf={view.as_of} unverified={view.policy.unverified} />}>{label}</WithInfo>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function FindingsCard({ view, packageId, canDecide, onDecide }: { view: NonNullable<ReturnType<typeof useIndependence>['data']>; packageId: string; canDecide: boolean; onDecide: (finding: IndependenceFinding) => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.controls.findings.title')}>
      <p className="vnd-note">{t('vnd.controls.findings.note')}</p>
      {view.findings.length === 0 ? (
        <Empty text={view.gate.checked ? t('vnd.controls.findings.none.text') : t('vnd.controls.findings.never.text')} testId="findings-empty" />
      ) : (
        <DataTable<IndependenceFinding>
          caption={t('vnd.controls.findings.caption')}
          rows={view.findings}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-finding-id': row.id })}
          columns={[
            {
              key: 'kind',
              header: t('vnd.controls.column.kind'),
              pinned: true,
              render: (row) => (
                <span className="vnd-stack">
                  <span>{findingKindLabel(t, row.kind)}</span>
                  <StatusPill tone={row.strength === 'STRONG' ? 'danger' : 'warning'} icon={row.strength === 'STRONG' ? '!' : '·'}>
                    {strengthLabel(t, row.strength)}
                  </StatusPill>
                </span>
              ),
            },
            {
              key: 'parties',
              header: t('vnd.controls.column.parties'),
              render: (row) => (
                <span className="vnd-stack">
                  {row.parties.map((party) =>
                    party.kind === 'CONTRACTOR' ? (
                      <Link key={party.id} to={CONTROLS_PATHS.finance(party.id, packageId)}>
                        {party.name ?? party.id}
                      </Link>
                    ) : (
                      <span key={`${party.kind}:${party.id}`}>{party.kind === 'OWNER_ORGANISATION' ? t('vnd.controls.party.owner') : (party.name ?? party.id)}</span>
                    ),
                  )}
                </span>
              ),
            },
            {
              key: 'evidence',
              header: t('vnd.controls.column.evidence'),
              render: (row) => <span className="vnd-days">{Object.entries(row.evidence).map(([name, value]) => `${name}: ${String(value)}`).join(' · ') || NONE}</span>,
            },
            {
              key: 'decision',
              header: t('vnd.controls.column.decision'),
              render: (row) =>
                row.decision === null ? (
                  <StatusPill tone="warning" icon="○">
                    {t('vnd.controls.decision.none.name')}
                  </StatusPill>
                ) : (
                  <span className="vnd-stack">
                    <StatusPill tone={row.decision === 'BLOCKED' ? 'danger' : 'success'} icon="✓">
                      {decisionLabel(t, row.decision)}
                    </StatusPill>
                    <span className="vnd-days">{row.decision_reason ?? NONE}</span>
                    {row.decided_at !== null && <span className="vnd-days">{vietnamStamp(row.decided_at)}</span>}
                  </span>
                ),
            },
            {
              key: 'actions',
              header: t('vnd.controls.column.actions'),
              render: (row) =>
                canDecide && row.can_decide ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="decide-finding" onClick={() => onDecide(row)}>
                    {t('vnd.controls.decide.action')}
                  </button>
                ) : null,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

function ControlsCard({ query, canSet, onSet, locale }: { query: ReturnType<typeof usePackageControls>; canSet: boolean; onSet: (controls: PackageControls) => void; locale: string }) {
  const { t } = useTranslation();
  const data = query.data;
  return (
    <SectionCard title={t('vnd.controls.package.section')}>
      {query.isError && data === undefined ? (
        <PartialNotice text={t('vnd.controls.package.failed.text')} onRetry={() => void query.refetch()} testId="controls-failed" />
      ) : data === undefined ? (
        <Empty text={t('vnd.controls.package.loading.text')} testId="controls-loading" />
      ) : (
        <>
          <dl className="vnd-facts" data-testid="package-controls">
            <ControlFact label={t('vnd.controls.package.security.label')} value={moneyText(data.security_base_amount, locale)} formula={t('vnd.controls.package.security.formula')} />
            <ControlFact label={t('vnd.controls.package.valid.label')} value={data.bid_valid_until === null ? NONE : dayText(data.bid_valid_until)} formula={t('vnd.controls.package.valid.formula')} />
            <ControlFact label={t('vnd.controls.package.value.label')} value={moneyText(data.estimated_value ?? data.budget_vnd, locale)} formula={t('vnd.controls.package.value.formula')} />
            <ControlFact label={t('vnd.controls.package.months.label')} value={data.duration_months === null ? NONE : String(data.duration_months)} formula={t('vnd.controls.package.months.formula')} />
          </dl>
          {canSet && (
            <button type="button" className="ui-button ui-button--outline" data-testid="set-controls" onClick={() => onSet(data)}>
              {t('vnd.controls.package.action')}
            </button>
          )}
        </>
      )}
    </SectionCard>
  );
}

function ControlFact({ label, value, formula }: { label: string; value: string; formula: string }) {
  const { t } = useTranslation();
  return (
    <div className="vnd-fact">
      <dt>
        <WithInfo info={<CountInfo name={label} formula={formula} source={t('vnd.controls.package.source.text')} asOf={new Date().toISOString()} />}>{label}</WithInfo>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function InterestsCard({ query, canDeclare, canEnd, onEnd }: { query: ReturnType<typeof useInterests>; canDeclare: boolean; canEnd: boolean; onEnd: (interest: PersonInterest) => void }) {
  const { t } = useTranslation();
  const rows = query.data?.items ?? [];
  return (
    <SectionCard title={t('vnd.controls.interests.title')}>
      <p className="vnd-note">{canDeclare ? t('vnd.controls.interests.note') : t('vnd.controls.interests.readonly')}</p>
      {query.isError && query.data === undefined ? (
        <PartialNotice text={t('vnd.controls.interests.failed.text')} onRetry={() => void query.refetch()} testId="interests-failed" />
      ) : rows.length === 0 ? (
        <Empty text={t('vnd.controls.interests.empty.text')} testId="interests-empty" />
      ) : (
        <DataTable<PersonInterest>
          caption={t('vnd.controls.interests.caption')}
          rows={rows}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-interest-id': row.id })}
          columns={[
            { key: 'member', header: t('vnd.controls.column.member'), pinned: true, render: (row) => row.member_name ?? row.membership_id },
            { key: 'kind', header: t('vnd.controls.column.interest'), render: (row) => interestKindLabel(t, row.kind) },
            { key: 'about', header: t('vnd.controls.column.about'), render: (row) => row.contractor_name ?? row.related_name ?? row.tax_head ?? NONE },
            { key: 'since', header: t('vnd.controls.column.since'), render: (row) => dayText(row.since_on) },
            {
              key: 'actions',
              header: t('vnd.controls.column.actions'),
              render: (row) =>
                canEnd && row.ended_on === null ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="end-interest" onClick={() => onEnd(row)}>
                    {t('vnd.controls.interest.end.action')}
                  </button>
                ) : null,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}
