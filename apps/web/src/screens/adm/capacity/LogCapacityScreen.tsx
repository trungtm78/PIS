import { useState } from 'react';
import { camel } from '../../mdm/catalogues';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { KitTable } from '../KitTable';
import { useLogCapacity, useSaveLogCapacity } from './hooks';
import { MANAGE_CAPACITY_PERMISSION, READ_CAPACITY_PERMISSION, byteText, classRows, describeProblem, emptyForm, formOf, toSaveBody, validateCap } from './model';
import type { CapErrors, CapField, CapForm, CapPolicyView, ClassRow } from './model';

const NEVER_EMPTY = (): boolean => false;
const TONE: Readonly<Record<ClassRow['state'], Tone>> = { UNCAPPED: 'neutral', OK: 'success', NEAR: 'warning', OVER: 'danger' };
const pctText = (value: number | null): string => (value === null ? '-' : `${value}%`);

/**
 * ADM-30: the caps on the number and the size of the log classes (HT.06). A technical class over its cap is archived to a hashed file and then purged by the nightly run, never below its retention rule; the audit
 * trail is only measured and alerted. The size of a big class is estimated from a sample and says so.
 */
export default function LogCapacityScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <LogCapacityContent key={tenantId ?? 'none'} route={route} />;
}

function LogCapacityContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_CAPACITY_PERMISSION);
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_CAPACITY_PERMISSION)) && mode !== 'READ_ONLY';
  const overview = useLogCapacity(canRead);
  const queryState = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: NEVER_EMPTY });
  const state = canRead ? queryState : 'denied';
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const rows = overview.data === undefined ? [] : classRows(overview.data);
  const target = rows.find((row) => row.recordClass === editing);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.logCapacity.page.title')}</h1>
          <p>{t('adm.logCapacity.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void overview.refetch()}>
        <SectionCard title={t('adm.logCapacity.list.title')}>
          <KitTable caption={t('adm.logCapacity.list.caption')} testId="classes">
            <thead>
              <tr>
                <th scope="col">{t('adm.logCapacity.col.class')}</th>
                <th scope="col">{t('adm.logCapacity.col.kind')}</th>
                <th scope="col">{t('adm.logCapacity.col.rows')}</th>
                <th scope="col">{t('adm.logCapacity.col.size')}</th>
                <th scope="col">{t('adm.logCapacity.col.cap')}</th>
                <th scope="col">{t('adm.logCapacity.col.state')}</th>
                <th scope="col">{t('adm.logCapacity.col.eligible')}</th>
                <th scope="col">{t('adm.logCapacity.col.protected')}</th>
                {mayManage ? <th scope="col">{t('adm.logCapacity.col.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.recordClass} data-record-class={row.recordClass} data-state={row.state}>
                  <th scope="row">{row.recordClass}</th>
                  <td>{row.kind === 'TECHNICAL' ? t('adm.logCapacity.kind.technical') : t('adm.logCapacity.kind.monitor')}</td>
                  <td>{row.reading === undefined ? t('adm.logCapacity.notMeasured') : row.reading.rows}</td>
                  <td>{row.reading === undefined ? '-' : `${row.reading.bytesEstimated ? '~' : ''}${byteText(row.reading.bytes)}`}</td>
                  <td>
                    {row.policy === undefined
                      ? t('adm.logCapacity.noCap')
                      : t('adm.logCapacity.capText', { rows: row.policy.maxRows ?? '-', bytes: row.policy.maxBytes === null ? '-' : byteText(row.policy.maxBytes), warn: row.policy.warnPct, usedRows: pctText(row.rowsPct), usedBytes: pctText(row.bytesPct) })}
                  </td>
                  <td>
                    <StatusPill tone={TONE[row.state]}>{t(`adm.logCapacity.state.${camel(row.state)}`)}</StatusPill>
                  </td>
                  <td>{row.kind === 'MONITOR_ONLY' ? t('adm.logCapacity.neverPurged') : (row.reading?.eligibleRows ?? '-')}</td>
                  <td>{row.reading?.protectedRows ?? '-'}</td>
                  {mayManage ? (
                    <td>
                      <button type="button" className="btn" onClick={() => setEditing(row.recordClass)}>
                        {row.policy === undefined ? t('adm.logCapacity.set.action') : t('adm.logCapacity.change.action')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </KitTable>
        </SectionCard>
        {mayManage && target !== undefined ? <CapFormCard key={target.recordClass} row={target} onDone={() => setEditing(undefined)} /> : null}
        <SectionCard title={t('adm.logCapacity.batches.title')}>
          {(overview.data?.batches ?? []).length === 0 ? (
            <p className="muted" data-testid="no-batches">
              {t('adm.logCapacity.batches.none')}
            </p>
          ) : (
            <KitTable caption={t('adm.logCapacity.batches.caption')} testId="batches">
              <thead>
                <tr>
                  <th scope="col">{t('adm.logCapacity.col.class')}</th>
                  <th scope="col">{t('adm.logCapacity.batch.status')}</th>
                  <th scope="col">{t('adm.logCapacity.col.rows')}</th>
                  <th scope="col">{t('adm.logCapacity.col.size')}</th>
                  <th scope="col">{t('adm.logCapacity.batch.hash')}</th>
                  <th scope="col">{t('adm.logCapacity.batch.at')}</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.batches ?? []).map((batch) => (
                  <tr key={batch.id}>
                    <th scope="row">{batch.recordClass}</th>
                    <td>{batch.status === 'PURGED' ? t('adm.logCapacity.batch.purged') : t('adm.logCapacity.batch.archived')}</td>
                    <td>{batch.rows}</td>
                    <td>{byteText(batch.bytes)}</td>
                    <td>
                      <code>{batch.fileSha256.slice(0, 16)}</code>
                    </td>
                    <td>{batch.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('adm.logCapacity.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function CapFormCard({ row, onDone }: { row: ClassRow; onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSaveLogCapacity();
  const current: CapPolicyView | undefined = row.policy;
  const [form, setForm] = useState<CapForm>(current === undefined ? emptyForm(row.recordClass) : formOf(current));
  const [errors, setErrors] = useState<CapErrors>({});
  const [saved, setSaved] = useState(false);
  const refused = save.isError ? describeProblem(save.error) : undefined;

  const change = (patch: Partial<CapForm>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    setErrors({});
    setSaved(false);
    if (save.isError) save.reset();
  };
  const problem = (field: CapField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : t(`adm.logCapacity.problem.${found}`);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (save.isPending) return;
    const found = validateCap(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(toSaveBody(form, current), {
      onSuccess: () => {
        setSaved(true);
        onDone();
      },
    });
  };
  const input = (field: 'maxRows' | 'maxBytes' | 'warnPct', id: string, label: string, hint?: string) => (
    <div className="field" data-field={field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="numeric" value={form[field]} aria-invalid={errors[field] !== undefined} onChange={(event) => change({ [field]: event.target.value })} />
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {problem(field) === undefined ? null : (
        <small role="alert" className="field-error">
          {problem(field)}
        </small>
      )}
    </div>
  );

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('adm.logCapacity.form.aria')}>
      <h2>{t('adm.logCapacity.form.title', { type: row.recordClass })}</h2>
      <p className="sub">{row.kind === 'TECHNICAL' ? t('adm.logCapacity.form.hintTechnical') : t('adm.logCapacity.form.hintMonitor')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {t(`adm.logCapacity.refused.${refused}`)}
        </p>
      )}
      {problem('limit') === undefined ? null : (
        <p role="alert" className="field-error">
          {problem('limit')}
        </p>
      )}
      {input('maxRows', 'log-cap-rows', t('adm.logCapacity.field.maxRows'), row.reading === undefined ? undefined : t('adm.logCapacity.field.protectedHint', { count: row.reading.protectedRows }))}
      {input('maxBytes', 'log-cap-bytes', t('adm.logCapacity.field.maxBytes'), t('adm.logCapacity.field.bytesHint'))}
      {input('warnPct', 'log-cap-warn', t('adm.logCapacity.field.warnPct'))}
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={(event) => change({ active: event.target.checked })} /> {t('adm.logCapacity.field.active')}
        </label>
      </div>
      <div className="field" data-field="reason">
        <label htmlFor="log-cap-reason">{t('adm.logCapacity.field.reason')}</label>
        <textarea id="log-cap-reason" rows={2} value={form.reason} aria-invalid={errors.reason !== undefined} onChange={(event) => change({ reason: event.target.value })} />
        {problem('reason') === undefined ? null : (
          <small role="alert" className="field-error">
            {problem('reason')}
          </small>
        )}
      </div>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={save.isPending}>
          {t('adm.logCapacity.form.save')}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t('adm.logCapacity.form.cancel')}
        </button>
        {saved ? (
          <span role="status" className="sub">
            {t('adm.logCapacity.form.saved')}
          </span>
        ) : null}
      </div>
    </form>
  );
}
