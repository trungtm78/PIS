import { useId, useState } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../../ui';
import type { DataTableColumn } from '../../../../ui';
import { failureCode, vietnamStamp } from '../shared/format';
import { Field, ReadonlyNote } from '../shared/parts';
import { useDecideHpmCorrection, useHpmConnection, useHpmCorrections, useProposeHpmCorrection } from './hooks';
import { correctionStateLabel, hpmErrorText } from './labels';
import { CORRECTION_STATES, EMPTY_CORRECTION_FORM, correctionBody, correctionProblems, correctionTone } from './model';
import type { Correction, CorrectionForm, CorrectionState } from './model';
import '../shared/shared.css';

/**
 * HPM-02, the corrections that let an accepted period be replaced (ENT-2, R8): one person proposes with the reopening of the period and a reason, another decides, the push that replaces the period uses the approved
 * correction once. Every decision is audited in ADM-11 by the server; the screen offers the decision only where the server says the caller may (never to the proposer).
 */
export default function CorrectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CorrectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'propose' } | { kind: 'decide'; correction: Correction } | undefined;

function CorrectionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const [filter, setFilter] = useState<CorrectionState | undefined>(undefined);
  const filterId = useId();
  const query = useHpmCorrections(filter);
  const connection = useHpmConnection();
  const [dialog, setDialog] = useState<Dialog>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const state = useScreenState({ isLoading: query.isLoading, error: rows.length === 0 ? query.error : undefined, data: query.data === undefined ? undefined : rows, isEmpty: (data) => Array.isArray(data) && data.length === 0 });
  const refreshFailed = query.isError && rows.length > 0;
  const asOf = vietnamStamp(query.data?.pages[0]?.as_of);
  const mayPropose = connection.data?.actions.may_propose_correction === true && mode !== 'READ_ONLY';
  const columns: DataTableColumn<Correction>[] = [
    { key: 'series', header: t('hpm.correction.column.series'), pinned: true, render: (row) => `${row.layout_code} · ${row.period}` },
    { key: 'revision', header: t('hpm.correction.column.revision'), align: 'right', render: (row) => row.from_revision },
    { key: 'reopen', header: t('hpm.correction.column.reopen'), render: (row) => <code className="ent2-key">{row.period_reopen_id}</code> },
    { key: 'reason', header: t('hpm.correction.column.reason'), render: (row) => row.reason },
    {
      key: 'state',
      header: t('hpm.correction.column.state'),
      render: (row) => (
        <StatusPill tone={correctionTone(row.state)}>{correctionStateLabel(t, row.state)}</StatusPill>
      ),
    },
    { key: 'proposer', header: t('hpm.correction.column.proposer'), render: (row) => row.proposed_by_name ?? '–' },
    { key: 'decider', header: t('hpm.correction.column.decider'), render: (row) => (row.decided_by_name === null ? '–' : `${row.decided_by_name} · ${vietnamStamp(row.decided_at)}`) },
    {
      key: 'actions',
      header: t('hpm.correction.column.actions'),
      render: (row) =>
        row.actions.may_decide && mode !== 'READ_ONLY' ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`decide-${row.id}`} onClick={() => { setNote(undefined); setDialog({ kind: 'decide', correction: row }); }}>
            {t('hpm.correction.decide.action')}
          </button>
        ) : null,
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('hpm.correction.page.title')}</h1>
          <p>{t('hpm.correction.page.subtitle')}</p>
        </div>
        {mayPropose && (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" data-testid="propose-button" onClick={() => { setNote(undefined); setDialog({ kind: 'propose' }); }}>
              {t('hpm.correction.header.propose.action')}
            </button>
          </div>
        )}
      </div>
      <ContextBar items={[{ label: t('hpm.context.scope.label'), value: tenant?.name ?? '–' }]} {...(asOf === '' ? {} : { asOf })} stale={refreshFailed} />
      {note !== undefined && (
        <p className="callout ent2-receipt" role="status" data-testid="action-receipt">
          {note}
        </p>
      )}
      {mode === 'READ_ONLY' && <ReadonlyNote block="MODE" />}
      {mode !== 'READ_ONLY' && connection.data !== undefined && !mayPropose && !connection.data.actions.may_decide_correction && <ReadonlyNote block="RIGHT" />}
      <div className="ent2-filter">
        <label htmlFor={filterId}>{t('hpm.correction.filter.label')}</label>
        <select id={filterId} value={filter ?? ''} onChange={(event) => setFilter(CORRECTION_STATES.find((value) => value === event.target.value))} data-testid="correction-filter">
          <option value="">{t('hpm.correction.filter.all')}</option>
          {CORRECTION_STATES.map((value) => (
            <option key={value} value={value}>
              {correctionStateLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <StateBoundary state={state === 'empty' ? 'default' : state} onRetry={() => void query.refetch()}>
        <SectionCard title={t('hpm.correction.section.title')}>
          {rows.length === 0 ? (
            <p className="ent2-none" role="status" data-testid="correction-empty">
              {filter === undefined ? t('hpm.correction.empty.none') : t('hpm.correction.empty.filtered')}
            </p>
          ) : (
            <DataTable caption={t('hpm.correction.section.title')} columns={columns} rows={rows} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-correction-id': row.id, 'data-state': row.state })} />
          )}
          {query.hasNextPage && (
            <p className="ent2-more">
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} data-testid="correction-more" onClick={() => void query.fetchNextPage()}>
                {t('hpm.correction.more.action')}
              </button>
            </p>
          )}
        </SectionCard>
      </StateBoundary>
      {dialog?.kind === 'propose' && (
        <ProposeDialog
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            setNote(t('hpm.correction.propose.done'));
          }}
        />
      )}
      {dialog?.kind === 'decide' && (
        <DecideDialog
          correction={dialog.correction}
          onClose={() => setDialog(undefined)}
          onDone={(decision) => {
            setDialog(undefined);
            setNote(decision === 'APPROVE' ? t('hpm.correction.decide.done.approved') : t('hpm.correction.decide.done.rejected'));
          }}
          onReload={() => void query.refetch()}
        />
      )}
      <p className="prototype-note">{t('hpm.correction.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ProposeDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useProposeHpmCorrection();
  const [form, setForm] = useState<CorrectionForm>(EMPTY_CORRECTION_FORM);
  const [problems, setProblems] = useState<ReturnType<typeof correctionProblems>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const set = (field: keyof CorrectionForm) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [field]: event.target.value }));
  return (
    <ConfirmDialog
      open
      title={t('hpm.correction.propose.title')}
      context={[{ label: t('hpm.correction.proposeContext.rule.label'), value: t('hpm.correction.proposeContext.rule.value') }]}
      confirmLabel={t('hpm.correction.propose.confirm')}
      cancelLabel={t('hpm.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const found = correctionProblems(form);
        setProblems(found);
        if (Object.keys(found).length > 0) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync(correctionBody(form)).then(onDone, (failure: unknown) => setError(hpmErrorText(t, failure)));
      }}
    >
      <Field id={`${id}-layout`} label={t('hpm.correction.field.layout.label')} problem={problems.layoutCode}>
        <input id={`${id}-layout`} value={form.layoutCode} onChange={set('layoutCode')} aria-invalid={problems.layoutCode !== undefined} data-testid="correction-layout" />
      </Field>
      <Field id={`${id}-period`} label={t('hpm.correction.field.period.label')} problem={problems.period}>
        <input id={`${id}-period`} value={form.period} onChange={set('period')} aria-invalid={problems.period !== undefined} data-testid="correction-period" />
      </Field>
      <Field id={`${id}-revision`} label={t('hpm.correction.field.revision.label')} problem={problems.fromRevision}>
        <input id={`${id}-revision`} inputMode="numeric" value={form.fromRevision} onChange={set('fromRevision')} aria-invalid={problems.fromRevision !== undefined} data-testid="correction-revision" />
      </Field>
      <Field id={`${id}-reopen`} label={t('hpm.correction.field.reopen.label')} problem={problems.periodReopenId} hint={t('hpm.correction.field.reopen.hint')}>
        <input id={`${id}-reopen`} value={form.periodReopenId} onChange={set('periodReopenId')} aria-invalid={problems.periodReopenId !== undefined} data-testid="correction-reopen" />
      </Field>
      <Field id={`${id}-reason`} label={t('hpm.correction.field.reason.label')} problem={problems.reason}>
        <textarea id={`${id}-reason`} rows={3} value={form.reason} onChange={set('reason')} aria-invalid={problems.reason !== undefined} data-testid="correction-reason" />
      </Field>
    </ConfirmDialog>
  );
}

function DecideDialog({ correction, onClose, onDone, onReload }: { correction: Correction; onClose: () => void; onDone: (decision: 'APPROVE' | 'REJECT') => void; onReload: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useDecideHpmCorrection();
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('hpm.correction.decide.title')}
      context={[
        { label: t('hpm.correction.decideContext.series.label'), value: `${correction.layout_code} · ${correction.period}` },
        { label: t('hpm.correction.decideContext.revision.label'), value: String(correction.from_revision) },
        { label: t('hpm.correction.decideContext.proposer.label'), value: correction.proposed_by_name ?? '–' },
        { label: t('hpm.correction.decideContext.reason.label'), value: correction.reason },
      ]}
      confirmLabel={decision === 'APPROVE' ? t('hpm.correction.decide.confirm.approve') : t('hpm.correction.decide.confirm.reject')}
      cancelLabel={t('hpm.dialog.cancel.action')}
      reason={{ label: t('hpm.correction.decide.reason.label'), required: true, minLength: 10, hint: t('hpm.correction.decide.reason.hint') }}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => {
        setError(undefined);
        mutation.mutateAsync({ id: correction.id, version: correction.version, decision, reason: reason ?? '' }).then(
          () => onDone(decision),
          (failure: unknown) => {
            setError(hpmErrorText(t, failure));
            if (failureCode(failure) === 'VERSION_CONFLICT') onReload();
          },
        );
      }}
    >
      <fieldset className="ent2-choice">
        <legend>{t('hpm.correction.decideField.decision.label')}</legend>
        <label>
          <input type="radio" name={`${id}-decision`} checked={decision === 'APPROVE'} onChange={() => setDecision('APPROVE')} data-testid="decision-approve" />
          {t('hpm.correction.decideField.decision.approve')}
        </label>
        <label>
          <input type="radio" name={`${id}-decision`} checked={decision === 'REJECT'} onChange={() => setDecision('REJECT')} data-testid="decision-reject" />
          {t('hpm.correction.decideField.decision.reject')}
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}
