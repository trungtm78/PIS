import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, SubmitWithImpact } from './components';
import { useChange, useQueue, useRecords } from './hooks';
import { changeStatusLabel, fieldProblemMessage, problemMessage } from './labels';
import { PROPOSE_PERMISSION, describeProblem, isCalendarDate } from './model';
import type { ChangeView, RecordView } from './model';
import { useConversions, useRecordSuccession, useRecordsAsOf } from './succession-hooks';
import { successionKindLabel, successionProblemMessage } from './succession-labels';
import { EMPTY_SUCCESSION_FORM, REFORM_DATE, STRUCTURE_TYPES, SUCCESSION_KINDS, connectorsOf, dayBefore, edgesOn, toProposedSuccession, validateSuccession } from './succession-model';
import type { SuccessionField, SuccessionForm, SuccessionKind, SuccessionProblem } from './succession-model';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './mdm.css';

const APPROVAL_PATH = '/mdm/mdm-32';
const NEVER_EMPTY = (): boolean => false;

/** An entry that can hand over: it is in force. */
const canHandOver = (record: RecordView): boolean => record.status === 'EFFECTIVE';
/** An entry that can take over: it is in force, or published and waiting for its date. */
const canTakeOver = (record: RecordView): boolean => record.status === 'EFFECTIVE' || record.status === 'APPROVED';

/**
 * MDM-37: the inheritance tree of the 2025 reform (ST-MDM-009). Two columns, the entries before a date and from it, joined by connectors
 * named after the succession (MERGE, SPLIT, RELEVEL, ...); the date is chosen by the person. A steward records an edge here, and it is
 * reviewed and published like every other master data change in MDM-32.
 */
export default function SuccessionScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <SuccessionContent key={tenantId ?? 'none'} route={route} />;
}

function SuccessionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const [masterType, setMasterType] = useState<string>(STRUCTURE_TYPES[0]);
  const [date, setDate] = useState(REFORM_DATE);
  const valid = isCalendarDate(date);
  // A date that is not a date is not read: the page keeps the last structure and the field says what is wrong.
  const day = valid ? date : REFORM_DATE;
  const earlier = dayBefore(day);

  const before = useRecordsAsOf([masterType], earlier);
  const after = useRecordsAsOf([masterType], day);
  const everyone = useRecords(masterType);
  const candidates = useMemo(() => {
    const standing = new Set((after.data ?? []).filter((record) => record.versionId !== null).map((record) => record.id));
    return (before.data ?? []).filter((record) => record.versionId !== null && !standing.has(record.id)).map((record) => record.id);
  }, [before.data, after.data]);
  const conversions = useConversions(candidates, day);
  const review = useQueue('IN_REVIEW');
  const draft = useQueue('DRAFT');
  const approved = useQueue('APPROVED');

  const state = useScreenState({
    isLoading: before.isLoading || after.isLoading || everyone.isLoading || conversions.isLoading || review.isLoading || draft.isLoading || approved.isLoading,
    error: before.error ?? after.error ?? everyone.error ?? conversions.error ?? review.error ?? draft.error ?? approved.error,
    data: everyone.data,
    isEmpty: NEVER_EMPTY,
  });
  const connectors = useMemo(() => connectorsOf(edgesOn(conversions.edges, day)), [conversions.edges, day]);
  const involved = useMemo(() => new Set(connectors.flatMap((connector) => [...connector.before, ...connector.after].map((entry) => entry.recordId))), [connectors]);
  const unchanged = useMemo(() => {
    const standing = new Set((before.data ?? []).filter((record) => record.versionId !== null).map((record) => record.id));
    return (after.data ?? []).filter((record) => record.versionId !== null && standing.has(record.id) && !involved.has(record.id)).length;
  }, [before.data, after.data, involved]);
  const open = useMemo(
    () => [...(draft.data ?? []), ...(review.data ?? []), ...(approved.data ?? [])].filter((change) => change.changeKind === 'SUCCESSION' && change.masterType === masterType),
    [draft.data, review.data, approved.data, masterType],
  );

  const refetch = (): void => void Promise.all([before.refetch(), after.refetch(), everyone.refetch(), conversions.refetch(), review.refetch(), draft.refetch(), approved.refetch()]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.succession.page.title')}</h1>
          <p>{t('mdm.succession.page.subtitle')}</p>
        </div>
        <div className="row-actions">
          <Link to={APPROVAL_PATH}>{t('mdm.succession.queue.link')}</Link>
        </div>
      </div>
      <p className="callout" role="note" data-testid="assumption">
        {t('mdm.succession.assumption.notice')}
      </p>
      <form className="card mdm-filters" role="search" aria-label={t('mdm.succession.controls.aria')} onSubmit={(event) => event.preventDefault()}>
        <Field id="succession-type" label={t('mdm.succession.type.label')} error={undefined}>
          <select id="succession-type" value={masterType} onChange={(event) => setMasterType(event.target.value)}>
            {STRUCTURE_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </Field>
        <Field id="succession-date" label={t('mdm.succession.date.label')} error={valid ? undefined : fieldProblemMessage(t, 'invalidDate')} hint={t('mdm.succession.date.hint')}>
          <input id="succession-date" type="date" value={date} aria-invalid={!valid} onChange={(event) => setDate(event.target.value)} />
        </Field>
      </form>
      <StateBoundary state={state} onRetry={refetch}>
        <div className="card" data-testid="succession-tree" data-as-of={day}>
          <div className="mdm-succession mdm-succession-head" aria-hidden="false">
            <h2>{t('mdm.succession.before.title', { date: day })}</h2>
            {t('mdm.succession.connector.title')}
            <h2>{t('mdm.succession.after.title', { date: day })}</h2>
          </div>
          {connectors.length === 0 ? (
            <p className="muted" data-testid="no-succession">
              {t('mdm.succession.tree.empty.text', { date: day })}
            </p>
          ) : (
            <ol className="plain mdm-succession-list" aria-label={t('mdm.succession.tree.aria')}>
              {connectors.map((connector) => (
                <li key={connector.id} className="mdm-succession" data-connector={connector.kinds.join(' ')} data-testid="connector-row">
                  <ul className="plain" data-side="before">
                    {connector.before.map((entry) => (
                      <li key={entry.recordId} data-key={entry.key}>
                        <code>{entry.key}</code> {entry.label ?? ''}
                      </li>
                    ))}
                  </ul>
                  <div className="mdm-succession-connector">
                    {connector.kinds.map((kind) => (
                      <span key={kind} className="pill" data-kind={kind} title={successionKindLabel(t, kind)}>
                        {kind}
                      </span>
                    ))}
                    <span className="sub">{connector.kinds.map((kind) => successionKindLabel(t, kind)).join(' · ')}</span>
                  </div>
                  <ul className="plain" data-side="after">
                    {connector.after.map((entry) => (
                      <li key={entry.recordId} data-key={entry.key}>
                        <code>{entry.key}</code> {entry.label ?? ''}
                        {entry.sharePct === null ? null : <span className="sub"> {t('mdm.succession.share.text', { share: entry.sharePct })}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
          <p className="sub" data-testid="unchanged">
            {t('mdm.succession.unchanged.text', { count: unchanged })}
          </p>
        </div>

        <PendingSuccessions changes={open} records={everyone.data ?? []} />
        <RecordForm masterType={masterType} defaultDate={day} records={everyone.data ?? []} canPropose={canPropose} />
      </StateBoundary>
      <p className="prototype-note">{t('mdm.succession.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function PendingSuccessions({ changes, records }: { changes: readonly ChangeView[]; records: readonly RecordView[] }) {
  const { t } = useTranslation();
  const keyOf = (id: string): string => records.find((record) => record.id === id)?.businessKey ?? id;
  return (
    <section className="card" aria-label={t('mdm.succession.pending.title')} data-testid="pending">
      <h2>{t('mdm.succession.pending.title')}</h2>
      {changes.length === 0 ? (
        <p className="muted">{t('mdm.succession.pending.empty')}</p>
      ) : (
        <KitTable caption={t('w2mdm.succession.table.caption')}>
          <thead>
            <tr>
              <th>{t('mdm.succession.col.before')}</th>
              <th>{t('mdm.succession.col.after')}</th>
              <th>{t('mdm.succession.col.kind')}</th>
              <th>{t('mdm.succession.col.effective')}</th>
              <th>{t('mdm.succession.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => {
              const proposed = toProposedSuccession(change.proposed);
              return (
                <tr key={change.id} data-change-id={change.id} data-status={change.status}>
                  <td>
                    <code>{change.businessKey ?? ''}</code>
                  </td>
                  <td>{proposed?.edges.map((edge) => keyOf(edge.successorRecordId) + (edge.sharePct === null ? '' : ` (${edge.sharePct}%)`)).join(', ') ?? ''}</td>
                  <td>{proposed === undefined ? '' : successionKindLabel(t, proposed.kind)}</td>
                  <td>{change.effectiveFrom}</td>
                  <td>{changeStatusLabel(t, change.status)}</td>
                </tr>
              );
            })}
          </tbody>
        </KitTable>
      )}
    </section>
  );
}

function RecordForm({ masterType, defaultDate, records, canPropose }: { masterType: string; defaultDate: string; records: readonly RecordView[]; canPropose: boolean }) {
  const { t } = useTranslation();
  const record = useRecordSuccession();
  const [form, setForm] = useState<SuccessionForm>({ ...EMPTY_SUCCESSION_FORM, effectiveDate: defaultDate });
  const [errors, setErrors] = useState<Partial<Record<SuccessionField, SuccessionProblem>>>({});
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const change = useChange(opened);
  const problem = record.isError ? describeProblem(record.error) : undefined;

  const handing = useMemo(() => records.filter((candidate) => candidate.masterType === masterType && canHandOver(candidate)).sort((left, right) => left.businessKey.localeCompare(right.businessKey)), [records, masterType]);
  const taking = useMemo(() => records.filter((candidate) => candidate.masterType === masterType && canTakeOver(candidate)).sort((left, right) => left.businessKey.localeCompare(right.businessKey)), [records, masterType]);

  const setField = (field: SuccessionField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };
  const error = (field: SuccessionField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : successionProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (record.isPending || !canPropose || (opened !== undefined && form.kind !== 'SPLIT')) return;
    const found = validateSuccession({ ...form, masterType });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate(
      {
        predecessor_record_id: form.predecessorId,
        successor_record_id: form.successorId,
        succession_kind: form.kind,
        effective_date: form.effectiveDate,
        ...(form.kind === 'SPLIT' ? { share_pct: form.sharePct.trim() } : {}),
        legal_basis: form.legalBasis.trim(),
        reason: form.reason.trim(),
      },
      { onSuccess: (answer) => { setOpened((answer as { resource_id?: string }).resource_id); setSubmitted(false); } },
    );
  };

  // The next successor of a split: the entry and the share are typed again, everything else stays.
  const addAnother = (): void => {
    setForm((previous) => ({ ...previous, successorId: '', sharePct: '' }));
    record.reset();
  };

  return (
    <div className="mdm-grid">
      <form className="card" onSubmit={save} noValidate aria-label={t('mdm.succession.form.aria')}>
        <h2>{t('mdm.succession.form.title')}</h2>
        {!canPropose ? (
          <p className="callout warning" role="status">
            {t('mdm.readOnly.denied.notice')}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="record-problem">
            {problemMessage(t, problem)}
          </p>
        )}
        <fieldset disabled={!canPropose || (opened !== undefined && form.kind !== 'SPLIT')}>
          <Field id="succession-kind" label={t('mdm.succession.kind.label')} error={error('kind')}>
            <select id="succession-kind" value={form.kind} onChange={(event) => setField('kind', event.target.value as SuccessionKind)}>
              {SUCCESSION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind} · {successionKindLabel(t, kind)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="succession-before" label={t('mdm.succession.predecessor.label')} error={error('predecessorId')}>
            <select id="succession-before" value={form.predecessorId} aria-invalid={error('predecessorId') !== undefined} onChange={(event) => setField('predecessorId', event.target.value)}>
              <option value="">{t('mdm.succession.entry.none')}</option>
              {handing.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.businessKey} · {candidate.label ?? ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="succession-after" label={t('mdm.succession.successor.label')} error={error('successorId')}>
            <select id="succession-after" value={form.successorId} aria-invalid={error('successorId') !== undefined} onChange={(event) => setField('successorId', event.target.value)}>
              <option value="">{t('mdm.succession.entry.none')}</option>
              {taking.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.businessKey} · {candidate.label ?? ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="succession-effective" label={t('mdm.succession.effective.label')} error={error('effectiveDate')} hint={t('mdm.succession.effective.hint')}>
            <input id="succession-effective" type="date" value={form.effectiveDate} aria-invalid={error('effectiveDate') !== undefined} onChange={(event) => setField('effectiveDate', event.target.value)} />
          </Field>
          {form.kind === 'SPLIT' ? (
            <Field id="succession-share" label={t('mdm.succession.shareField.label')} error={error('sharePct')} hint={t('mdm.succession.shareField.hint')}>
              <input id="succession-share" inputMode="decimal" value={form.sharePct} aria-invalid={error('sharePct') !== undefined} onChange={(event) => setField('sharePct', event.target.value)} />
            </Field>
          ) : null}
          <Field id="succession-basis" label={t('mdm.succession.basis.label')} error={error('legalBasis')} hint={t('mdm.succession.basis.hint')}>
            <textarea id="succession-basis" rows={2} value={form.legalBasis} aria-invalid={error('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
          </Field>
          <Field id="succession-reason" label={t('mdm.succession.reason.label')} error={error('reason')}>
            <textarea id="succession-reason" rows={2} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
          </Field>
        </fieldset>
        <div className="adm-kit-actions">
          <span className="sub">{t('mdm.succession.form.hint')}</span>
          {canPropose && (opened === undefined || form.kind === 'SPLIT') ? (
            <button type="submit" className="ui-button ui-button--primary" disabled={record.isPending}>
              {t('mdm.succession.save.action')}
            </button>
          ) : null}
        </div>
      </form>
      <div>
        {opened === undefined ? null : (
          <>
            <p className="callout" role="status" data-testid="succession-saved">
              {t('mdm.succession.saved.notice')}
            </p>
            {form.kind === 'SPLIT' && !submitted ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={addAnother} data-testid="add-another">
                {t('mdm.succession.another.action')}
              </button>
            ) : null}
            {change.data === undefined || change.data === null || submitted ? null : <SubmitWithImpact change={change.data} canSubmit={canPropose} onSubmitted={() => setSubmitted(true)} />}
            {submitted ? (
              <p className="callout" role="status" data-testid="succession-submitted">
                {t('mdm.create.submitted.notice')} <Link to={APPROVAL_PATH}>{t('mdm.create.queue.link')}</Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
