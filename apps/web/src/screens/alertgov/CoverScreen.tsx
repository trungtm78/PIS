import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { useAssignees } from '../../ui/alerts/hooks';
import { Banner, DefectList, FigureInfo, RuleNote, TONE_OF, dayText, momentText, personText, problemText } from './components';
import { useAbsences, useCoverageReport, useDeclareAbsence, useDecideCover, useEndAbsence, useProposeCover, useRevokeCover } from './hooks';
import { absenceKindText, coverStatusText, coverageText, gapText, phaseText, positionText, sourceText } from './labels';
import { ABSENCE_KINDS, COVER_PERMISSION, COVER_SOURCES, HEALTH_PERMISSION, HOME_PERMISSION, defectsOf, momentField, momentOf } from './model';
import type { AbsenceRow, CoverRow, GapRow, PositionRow } from './model';

const REASON_MIN = 3;

function Problem({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  const { t } = useTranslation();
  if (error === null || error === undefined) return null;
  return (
    <Banner tone="danger" role="alert" testId="problem">
      <div>
        <p>{problemText(t, error)}</p>
        <DefectList defects={error instanceof ApiError ? defectsOf(error.extensions) : []} />
      </div>
      {onDismiss === undefined ? null : (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onDismiss}>
          {t('alertgov.common.dismiss.action')}
        </button>
      )}
    </Banner>
  );
}

function DeclareForm({ canForOthers }: { canForOthers: boolean }) {
  const { t } = useTranslation();
  const declare = useDeclareAbsence();
  const people = useAssignees(canForOthers);
  const [kind, setKind] = useState<string>('LEAVE');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [member, setMember] = useState('');
  const [checked, setChecked] = useState(false);
  const validFrom = momentOf(from);
  const validUntil = momentOf(until);
  const bad = validFrom === undefined || validUntil === undefined || validUntil <= validFrom;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setChecked(true);
    if (bad || validFrom === undefined || validUntil === undefined) return;
    declare.mutate({ membershipId: member === '' ? undefined : member, kind, validFrom, validUntil, reason: reason.trim() === '' ? undefined : reason.trim() }, { onSuccess: () => { setFrom(''); setUntil(''); setReason(''); setChecked(false); } });
  };
  return (
    <SectionCard title={t('alertgov.cover.declare.title')}>
      <form className="alertgov-form" onSubmit={submit} noValidate aria-label={t('alertgov.cover.declare.title')} data-testid="declare-form">
        <div className="alertgov-row">
          {canForOthers ? (
            <div className="field">
              <label htmlFor="alertgov-declare-member">{t('alertgov.cover.declare.member')}</label>
              <select id="alertgov-declare-member" value={member} onChange={(event) => setMember(event.target.value)} data-testid="declare-member">
                <option value="">{t('alertgov.cover.declare.self')}</option>
                {(people.data ?? []).map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="alertgov-declare-kind">{t('alertgov.cover.declare.kind')}</label>
            <select id="alertgov-declare-kind" value={kind} onChange={(event) => setKind(event.target.value)} data-testid="declare-kind">
              {ABSENCE_KINDS.map((one) => (
                <option key={one} value={one}>
                  {absenceKindText(t, one)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="alertgov-declare-from">{t('alertgov.cover.declare.from')}</label>
            <input id="alertgov-declare-from" type="datetime-local" value={from} aria-invalid={checked && validFrom === undefined} onChange={(event) => setFrom(event.target.value)} data-testid="declare-from" />
          </div>
          <div className="field">
            <label htmlFor="alertgov-declare-until">{t('alertgov.cover.declare.until')}</label>
            <input id="alertgov-declare-until" type="datetime-local" value={until} aria-invalid={checked && (validUntil === undefined || bad)} onChange={(event) => setUntil(event.target.value)} data-testid="declare-until" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="alertgov-declare-reason">{t('alertgov.cover.declare.reason')}</label>
          <input id="alertgov-declare-reason" type="text" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} data-testid="declare-reason" />
        </div>
        {checked && bad ? (
          <span className="alertgov-error" data-testid="declare-error">
            {t('alertgov.cover.declare.window.error')}
          </span>
        ) : null}
        <Problem error={declare.error} onDismiss={() => declare.reset()} />
        {declare.isSuccess ? <p className="alertgov-ok" role="status">{t('alertgov.cover.declare.done')}</p> : null}
        <div className="alertgov-actions">
          <button type="submit" className="ui-button ui-button--primary" disabled={declare.isPending} data-testid="declare-submit">
            {declare.isPending ? t('alertgov.cover.declare.pending') : t('alertgov.cover.declare.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}

function ProposeForm({ absence, onDone }: { absence: AbsenceRow; onDone: () => void }) {
  const { t } = useTranslation();
  const propose = useProposeCover();
  const people = useAssignees(true);
  const [deputy, setDeputy] = useState('');
  const [from, setFrom] = useState(momentField(absence.validFrom));
  const [until, setUntil] = useState(momentField(absence.effectiveUntil));
  const [scope, setScope] = useState<'ALL' | 'SOURCES'>('ALL');
  const [sources, setSources] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const validFrom = momentOf(from);
  const validUntil = momentOf(until);
  const bad = deputy === '' || validFrom === undefined || validUntil === undefined || validUntil <= validFrom || (scope === 'SOURCES' && sources.length === 0);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setChecked(true);
    if (bad || validFrom === undefined || validUntil === undefined) return;
    propose.mutate({ absenceId: absence.id, deputyId: deputy, validFrom, validUntil, scopeKind: scope, sources: scope === 'ALL' ? [] : sources }, { onSuccess: onDone });
  };
  return (
    <form className="alertgov-form" onSubmit={submit} noValidate aria-label={t('alertgov.cover.propose.title')} data-testid={`propose-form-${absence.id}`}>
      <div className="alertgov-row">
        <div className="field">
          <label htmlFor={`alertgov-deputy-${absence.id}`}>{t('alertgov.cover.propose.deputy')}</label>
          <select id={`alertgov-deputy-${absence.id}`} value={deputy} aria-invalid={checked && deputy === ''} onChange={(event) => setDeputy(event.target.value)} data-testid="propose-deputy">
            <option value="">{t('alertgov.cover.propose.choose')}</option>
            {(people.data ?? [])
              .filter((one) => one.id !== absence.membershipId)
              .map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`alertgov-propose-from-${absence.id}`}>{t('alertgov.cover.declare.from')}</label>
          <input id={`alertgov-propose-from-${absence.id}`} type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} data-testid="propose-from" />
        </div>
        <div className="field">
          <label htmlFor={`alertgov-propose-until-${absence.id}`}>{t('alertgov.cover.declare.until')}</label>
          <input id={`alertgov-propose-until-${absence.id}`} type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} data-testid="propose-until" />
        </div>
        <div className="field">
          <label htmlFor={`alertgov-propose-scope-${absence.id}`}>{t('alertgov.cover.propose.scope')}</label>
          <select id={`alertgov-propose-scope-${absence.id}`} value={scope} onChange={(event) => setScope(event.target.value === 'SOURCES' ? 'SOURCES' : 'ALL')} data-testid="propose-scope">
            <option value="ALL">{t('alertgov.cover.propose.scopeAll')}</option>
            <option value="SOURCES">{t('alertgov.cover.propose.scopeSources')}</option>
          </select>
        </div>
      </div>
      {scope === 'SOURCES' ? (
        <fieldset>
          <legend>{t('alertgov.cover.propose.sources')}</legend>
          <div className="alertgov-row">
            {COVER_SOURCES.map((source) => (
              <label key={source}>
                <input type="checkbox" checked={sources.includes(source)} onChange={(event) => setSources(event.target.checked ? [...sources, source] : sources.filter((one) => one !== source))} data-testid={`source-${source}`} /> {sourceText(t, source)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {checked && bad ? <span className="alertgov-error" data-testid="propose-error">{t('alertgov.cover.propose.invalid')}</span> : null}
      <span className="alertgov-sub">{t('alertgov.cover.propose.hint')}</span>
      <Problem error={propose.error} onDismiss={() => propose.reset()} />
      <div className="alertgov-actions">
        <button type="submit" className="ui-button ui-button--primary ui-button--small" disabled={propose.isPending} data-testid="propose-submit">
          {propose.isPending ? t('alertgov.cover.propose.pending') : t('alertgov.cover.propose.action')}
        </button>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onDone}>
          {t('alertgov.common.cancel.action')}
        </button>
      </div>
    </form>
  );
}

type Dialog = { kind: 'revoke'; cover: CoverRow } | { kind: 'end'; absence: AbsenceRow } | { kind: 'decide'; cover: CoverRow; decision: 'APPROVE' | 'REJECT' } | null;

function AbsenceCard({ absence, me, manager, onDialog }: { absence: AbsenceRow; me: string | undefined; manager: boolean; onDialog: (dialog: Dialog) => void }) {
  const { t } = useTranslation();
  const [proposing, setProposing] = useState(false);
  const isMine = me !== undefined && absence.membershipId.toLowerCase() === me.toLowerCase();
  const mayAct = isMine || manager;
  const live = absence.status === 'DECLARED' && absence.phase !== 'OVER';
  const maySelf = (cover: CoverRow): boolean => me !== undefined && [cover.absent?.id, cover.deputy?.id].some((id) => id?.toLowerCase() === me.toLowerCase());
  return (
    <li className="alertgov-card" data-testid={`absence-${absence.id}`} data-coverage={absence.coverage}>
      <div className="alertgov-row">
        <strong>{absence.name ?? absence.membershipId.slice(0, 8)}</strong>
        <StatusPill tone="info">{absenceKindText(t, absence.kind)}</StatusPill>
        <StatusPill tone={absence.status === 'DECLARED' ? 'default' : 'neutral'}>{absence.status === 'DECLARED' ? phaseText(t, absence.phase) : t('alertgov.absence.ended.text')}</StatusPill>
        {absence.coverage === 'NOT_APPLICABLE' ? null : <StatusPill tone={TONE_OF[absence.coverage] ?? 'neutral'}>{coverageText(t, absence.coverage)}</StatusPill>}
      </div>
      <span className="alertgov-sub">{t('alertgov.absence.window.text', { from: momentText(absence.validFrom), until: momentText(absence.effectiveUntil) })}</span>
      {absence.reason === null ? null : <span className="alertgov-sub">{absence.reason}</span>}
      {absence.covers.length === 0 ? (
        <span className="alertgov-sub" data-testid="no-covers">{t('alertgov.absence.noCovers.text')}</span>
      ) : (
        <ul className="alertgov-list" aria-label={t('alertgov.absence.covers.label')}>
          {absence.covers.map((cover) => (
            <li key={cover.id} className="alertgov-line" data-testid={`cover-${cover.id}`}>
              <span>
                {personText(cover.deputy)} · {momentText(cover.validFrom)} – {momentText(cover.validUntil)}{' '}
                <StatusPill tone={TONE_OF[cover.status] ?? 'neutral'}>{coverStatusText(t, cover.status)}</StatusPill>
                {cover.inForce ? <StatusPill tone="success">{t('alertgov.cover.inForce.text')}</StatusPill> : null}
              </span>
              <span className="alertgov-sub">{cover.scopeKind === 'ALL' ? t('alertgov.cover.scope.all') : t('alertgov.cover.scope.sources', { sources: cover.sources.map((source) => sourceText(t, source)).join(', ') })}</span>
              {(cover.status === 'PENDING' || cover.status === 'APPROVED') && (maySelf(cover) || manager) ? (
                <div className="alertgov-actions">
                  <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('alertgov.cover.revoke.label', { name: personText(cover.deputy) })} onClick={() => onDialog({ kind: 'revoke', cover })} data-testid={`revoke-${cover.id}`}>
                    {t('alertgov.cover.revoke.action')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {live && mayAct ? (
        <div className="alertgov-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setProposing(true)} disabled={proposing} data-testid={`propose-${absence.id}`}>
            {t('alertgov.cover.propose.open')}
          </button>
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onDialog({ kind: 'end', absence })} data-testid={`end-${absence.id}`}>
            {t('alertgov.absence.end.action')}
          </button>
        </div>
      ) : null}
      {proposing ? <ProposeForm absence={absence} onDone={() => setProposing(false)} /> : null}
    </li>
  );
}

function AbsenceList({ rows, me, manager, onDialog, caption }: { rows: AbsenceRow[]; me: string | undefined; manager: boolean; onDialog: (dialog: Dialog) => void; caption: string }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p data-testid="absences-empty">{t('alertgov.absence.empty.text')}</p>;
  return (
    <ul className="alertgov-list" aria-label={caption}>
      {rows.map((row) => (
        <AbsenceCard key={row.id} absence={row} me={me} manager={manager} onDialog={onDialog} />
      ))}
    </ul>
  );
}

function Coverage() {
  const { t } = useTranslation();
  const report = useCoverageReport(true);
  const state = useScreenState({ isLoading: report.isLoading, error: report.data === undefined ? report.error : undefined, data: report.data, isEmpty: () => false });
  const data = report.data;
  const positions: DataTableColumn<PositionRow>[] = [
    { key: 'role', header: t('alertgov.health.positions.role'), render: (row) => row.roleCode },
    { key: 'unit', header: t('alertgov.health.positions.unit'), render: (row) => row.unitName ?? row.unitId },
    { key: 'holders', header: t('alertgov.health.positions.holders'), align: 'right', render: (row) => `${row.present}/${row.holders}` },
    { key: 'state', header: t('alertgov.health.positions.state'), render: (row) => <StatusPill tone={row.state === 'UNCOVERED' ? 'danger' : row.state === 'SINGLE_POINT' ? 'warning' : 'success'}>{positionText(t, row.state)}</StatusPill> },
  ];
  const gaps: DataTableColumn<GapRow>[] = [
    { key: 'kind', header: t('alertgov.gap.column.kind'), render: (row) => gapText(t, row.kind) },
    { key: 'who', header: t('alertgov.gap.column.who'), render: (row) => row.name ?? row.membershipId?.slice(0, 8) ?? '—' },
    { key: 'items', header: t('alertgov.gap.column.items'), align: 'right', render: (row) => row.itemCount },
    { key: 'opened', header: t('alertgov.gap.column.opened'), render: (row) => momentText(row.openedAt) },
    { key: 'closed', header: t('alertgov.gap.column.closed'), render: (row) => (row.closedAt === null ? <StatusPill tone="danger">{t('alertgov.gap.open.text')}</StatusPill> : momentText(row.closedAt)) },
  ];
  return (
    <SectionCard title={t('alertgov.cover.report.title')} actions={data === undefined ? undefined : <FigureInfo name={t('alertgov.cover.report.title')} formula={data.rule.formula} source={data.rule.source} asOf={data.asOf} rule={data.rule} />}>
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {data === undefined ? null : (
          <div className="alertgov-stack" data-testid="coverage">
            <RuleNote rule={data.rule} />
            <p data-testid="coverage-summary">{data.summary.percent === null ? t('alertgov.cover.report.noPositions') : t('alertgov.cover.report.summary', { backed: data.summary.backedUp, total: data.summary.total, percent: data.summary.percent })}</p>
            <DataTable<PositionRow> caption={t('alertgov.health.positions.caption')} columns={positions} rows={data.positions} rowKey={(row) => row.key} state={data.positions.length === 0 ? 'empty' : 'ready'} emptyKind="none" />
            <h3>{t('alertgov.cover.report.gaps')}</h3>
            <DataTable<GapRow> caption={t('alertgov.cover.report.gapsCaption')} columns={gaps} rows={data.gaps} rowKey={(row) => row.id} state={data.gaps.length === 0 ? 'empty' : 'ready'} emptyKind="none" />
          </div>
        )}
      </StateBoundary>
    </SectionCard>
  );
}

/**
 * ADM-28: absences, deputies and the coverage of the receivers of alerts (G2-7). A person declares that they are away and proposes who takes their alerts over (all of them or some sources); a third person who manages covers allows it, never the proposer, the
 * absent person or the deputy; the deputy receives the alerts, not the authority to decide in a module (that goes through the delegation of ADM). A person away with nobody to cover them is a gap: it is shown here, counted as orphaned alerts, and the alerts
 * go up to the leadership meanwhile. The policy that sets the limits is shown with its version and the label of a starting value that nobody confirmed.
 */
export default function CoverScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CoverContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CoverContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const may = permissions === undefined || permissions.includes(HOME_PERMISSION);
  const manager = permissions === undefined || permissions.includes(COVER_PERMISSION);
  const reader = permissions === undefined || permissions.includes(HEALTH_PERMISSION);
  const me = tenant?.membershipId;
  const mine = useAbsences(true, 'current', may);
  const managed = useAbsences(false, 'current', may && manager);
  const end = useEndAbsence();
  const revoke = useRevokeCover();
  const decide = useDecideCover();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [endStatus, setEndStatus] = useState<'ENDED' | 'CANCELLED'>('ENDED');
  const queryState = useScreenState({ isLoading: mine.isLoading, error: mine.data === undefined ? mine.error : undefined, data: mine.data, isEmpty: () => false });
  const state = may ? queryState : 'denied';
  const close = (): void => {
    setDialog(null);
    end.reset();
    revoke.reset();
    decide.reset();
  };
  const pending = managed.data?.pendingCovers ?? [];
  const others = (managed.data?.items ?? []).filter((row) => me === undefined || row.membershipId.toLowerCase() !== me.toLowerCase());
  const rule = mine.data?.rule ?? managed.data?.rule;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('alertgov.cover.title')}</h1>
          <p>{t('alertgov.cover.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('alertgov.ctx.scope'), value: tenant?.name ?? t('alertgov.ctx.scopeAll') }]} {...(mine.data === undefined ? {} : { asOf: momentText(mine.data.asOf) })} />
      <StateBoundary state={state} onRetry={() => void mine.refetch()}>
        <div className="alertgov-stack">
          {mine.isError || managed.isError ? (
            <Banner tone="warning" testId="stale">
              <span>{t('alertgov.cover.stale.text')}</span>
            </Banner>
          ) : null}
          {rule === undefined ? null : <RuleNote rule={rule} />}
          <DeclareForm canForOthers={manager} />
          <SectionCard title={t('alertgov.cover.mine.title')}>
            <AbsenceList rows={mine.data?.items ?? []} me={me} manager={false} onDialog={setDialog} caption={t('alertgov.cover.mine.title')} />
          </SectionCard>
          {manager ? (
            <>
              <SectionCard title={t('alertgov.cover.pending.title')} unit={t('alertgov.cover.pending.count', { count: pending.length })}>
                {pending.length === 0 ? (
                  <p data-testid="pending-empty">{t('alertgov.cover.pending.empty')}</p>
                ) : (
                  <ul className="alertgov-list">
                    {pending.map((cover) => (
                      <li key={cover.id} className="alertgov-line" data-testid={`pending-${cover.id}`}>
                        <span>{t('alertgov.cover.pending.line', { absent: personText(cover.absent), deputy: personText(cover.deputy), from: dayText(cover.validFrom), until: dayText(cover.validUntil) })}</span>
                        <div className="alertgov-actions">
                          <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setDialog({ kind: 'decide', cover, decision: 'APPROVE' })} data-testid={`approve-${cover.id}`}>
                            {t('alertgov.cover.decide.approve')}
                          </button>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'decide', cover, decision: 'REJECT' })} data-testid={`reject-${cover.id}`}>
                            {t('alertgov.cover.decide.reject')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
              <SectionCard title={t('alertgov.cover.managed.title')}>
                <StateBoundary state={managed.isLoading ? 'loading' : managed.error === null ? 'default' : 'error'} onRetry={() => void managed.refetch()}>
                  <AbsenceList rows={others} me={me} manager onDialog={setDialog} caption={t('alertgov.cover.managed.title')} />
                </StateBoundary>
              </SectionCard>
            </>
          ) : null}
          {reader ? <Coverage /> : null}
        </div>
      </StateBoundary>
      <ConfirmDialog
        open={dialog?.kind === 'revoke'}
        title={t('alertgov.cover.revoke.title')}
        context={dialog?.kind === 'revoke' ? [{ label: t('alertgov.cover.revoke.context.absent'), value: personText(dialog.cover.absent) }, { label: t('alertgov.cover.revoke.context.deputy'), value: personText(dialog.cover.deputy) }] : []}
        confirmLabel={t('alertgov.cover.revoke.confirm')}
        cancelLabel={t('alertgov.common.cancel.action')}
        pending={revoke.isPending}
        reason={{ label: t('alertgov.common.reason.label'), required: true, minLength: REASON_MIN, hint: t('alertgov.common.reason.hint', { count: REASON_MIN }) }}
        {...(revoke.isError ? { error: problemText(t, revoke.error) } : {})}
        onConfirm={(reason) => dialog?.kind === 'revoke' && revoke.mutate({ id: dialog.cover.id, version: dialog.cover.version, reason: (reason ?? '').trim() }, { onSuccess: close })}
        onCancel={close}
      />
      <ConfirmDialog
        open={dialog?.kind === 'end'}
        title={t('alertgov.absence.end.title')}
        context={dialog?.kind === 'end' ? [{ label: t('alertgov.absence.end.context'), value: dialog.absence.name ?? dialog.absence.membershipId.slice(0, 8) }] : []}
        confirmLabel={t('alertgov.absence.end.confirm')}
        cancelLabel={t('alertgov.common.cancel.action')}
        pending={end.isPending}
        reason={{ label: t('alertgov.common.reason.label'), required: true, minLength: REASON_MIN, hint: t('alertgov.common.reason.hint', { count: REASON_MIN }) }}
        {...(end.isError ? { error: problemText(t, end.error) } : {})}
        onConfirm={(reason) => dialog?.kind === 'end' && end.mutate({ id: dialog.absence.id, version: dialog.absence.version, status: endStatus, reason: (reason ?? '').trim() }, { onSuccess: close })}
        onCancel={close}
      >
        <div className="field">
          <label htmlFor="alertgov-end-status">{t('alertgov.absence.end.status')}</label>
          <select id="alertgov-end-status" value={endStatus} onChange={(event) => setEndStatus(event.target.value === 'CANCELLED' ? 'CANCELLED' : 'ENDED')} data-testid="end-status">
            <option value="ENDED">{t('alertgov.absence.end.ended')}</option>
            <option value="CANCELLED">{t('alertgov.absence.end.cancelled')}</option>
          </select>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.kind === 'decide'}
        title={dialog?.kind === 'decide' && dialog.decision === 'REJECT' ? t('alertgov.cover.decide.rejectTitle') : t('alertgov.cover.decide.approveTitle')}
        context={dialog?.kind === 'decide' ? [{ label: t('alertgov.cover.revoke.context.absent'), value: personText(dialog.cover.absent) }, { label: t('alertgov.cover.revoke.context.deputy'), value: personText(dialog.cover.deputy) }] : []}
        confirmLabel={dialog?.kind === 'decide' && dialog.decision === 'REJECT' ? t('alertgov.cover.decide.reject') : t('alertgov.cover.decide.approve')}
        cancelLabel={t('alertgov.common.cancel.action')}
        pending={decide.isPending}
        reason={{ label: t('alertgov.cover.decide.note'), required: false }}
        {...(decide.isError ? { error: problemText(t, decide.error) } : {})}
        onConfirm={(note) => dialog?.kind === 'decide' && decide.mutate({ id: dialog.cover.id, version: dialog.cover.version, decision: dialog.decision, note: note === undefined || note.trim() === '' ? undefined : note.trim() }, { onSuccess: close })}
        onCancel={close}
      />
    </section>
  );
}
