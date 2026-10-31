import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import '../../prj/prj.css';
import { useFlags, useUpdateFlag } from './hooks';
import { RELEASE_PERMISSION, STATUSES, describeFlag, flagBody, formOfFlag, holds, isChangeable, validateFlag } from './model';
import type { FlagField, FlagForm, FlagProblem, FlagView, FormProblem, Status } from './model';

type T = Translator['t'];
const CLOSE_GLYPH = '×';
const NONE = '—';

function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'Off':
      return t('sas.flags.status.off');
    case 'Rollout':
      return t('sas.flags.status.rollout');
    case 'On':
      return t('sas.flags.status.on');
    case 'Retired':
      return t('sas.flags.status.retired');
  }
}

const statusTone = (status: Status): 'gray' | 'warn' | 'green' | 'blue' => (status === 'On' ? 'green' : status === 'Rollout' ? 'warn' : status === 'Retired' ? 'gray' : 'blue');

function problemMessage(t: T, problem: FlagProblem): string {
  switch (problem) {
    case 'rule':
      return t('sas.flags.problem.rule');
    case 'versionConflict':
      return t('sas.flags.problem.versionConflict');
    case 'notFound':
      return t('sas.flags.problem.notFound');
    case 'scopeDenied':
      return t('sas.flags.problem.scopeDenied');
    case 'validation':
      return t('sas.flags.problem.validation');
    case 'general':
      return t('sas.flags.problem.general');
  }
}

const fieldMessage = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('sas.flags.field.required.error') : t('sas.flags.field.invalid.error');

/**
 * SAS-20: the release flags (ST-SAS-020, SAS 3.11). Each flag the code declares is shown with its status, the cohorts, tenants and share it is rolled out to and its revision; the System Admin changes a flag under the
 * version they saw. A flag decides which code path a tenant runs while a release is staged and never grants an entitlement; a retired flag is final.
 */
export default function FlagsScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [editing, setEditing] = useState<FlagView | undefined>(undefined);
  const allowed = holds(permissions, RELEASE_PERMISSION, undefined);
  const list = useFlags(allowed);
  const items = list.data ?? [];
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 });
  const mayChange = holds(permissions, RELEASE_PERMISSION, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.flags.page.title')}</h1>
          <p>{t('sas.flags.page.subtitle')}</p>
        </div>
      </div>
      {allowed ? null : (
        <p className="callout warning" role="status" data-testid="denied">
          {t('sas.flags.denied.notice')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('sas.flags.list.aria')} data-testid="flags">
            <thead>
              <tr>
                <th scope="col">{t('sas.flags.col.flag')}</th>
                <th scope="col">{t('sas.flags.col.status')}</th>
                <th scope="col">{t('sas.flags.col.rollout')}</th>
                <th scope="col">{t('sas.flags.col.revision')}</th>
                <th scope="col">
                  <span className="sr-only">{t('sas.flags.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((flag) => (
                <tr key={flag.key} data-flag={flag.key} data-status={flag.status}>
                  <td>
                    <code>{flag.key}</code>
                    <span className="prj-code">{flag.description}</span>
                  </td>
                  <td>
                    <span className={`pill ${statusTone(flag.status)}`} data-status={flag.status}>
                      {statusLabel(t, flag.status)}
                    </span>
                  </td>
                  <td data-testid="rollout">{flag.status === 'Rollout' ? rolloutText(t, flag) : NONE}</td>
                  <td>
                    {t('sas.flags.revision.value', { revision: flag.revision })}
                    <span className="prj-code">{flag.updatedAt}</span>
                  </td>
                  <td>
                    {mayChange && isChangeable(flag) ? (
                      <button type="button" onClick={() => setEditing(flag)}>
                        {t('sas.flags.edit.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
      {editing === undefined ? null : <FlagDialog flag={editing} onClose={() => setEditing(undefined)} />}
      <p className="prototype-note">{t('sas.flags.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** Whom a flag in rollout is on for, in words. */
function rolloutText(t: T, flag: FlagView): string {
  const parts: string[] = [];
  if (flag.cohorts.length > 0) parts.push(t('sas.flags.rollout.cohorts', { cohorts: flag.cohorts.join(', ') }));
  if (flag.tenantIds.length > 0) parts.push(t('sas.flags.rollout.tenants', { count: flag.tenantIds.length }));
  if (flag.percentage > 0) parts.push(t('sas.flags.rollout.percentage', { percentage: flag.percentage }));
  return parts.join(' · ');
}

function FlagDialog({ flag, onClose }: { flag: FlagView; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = useUpdateFlag();
  const [form, setForm] = useState<FlagForm>(formOfFlag(flag));
  const [problems, setProblems] = useState<Partial<Record<FlagField, FormProblem>>>({});
  const refusal = send.isError ? describeFlag(send.error) : undefined;
  const set = (patch: Partial<FlagForm>): void => {
    setProblems({});
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateFlag(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate({ key: flag.key, version: flag.version, body: flagBody(form) }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('sas.flags.edit.title', { flag: flag.key })}</strong>
          <button type="button" className="icon-button" aria-label={t('sas.flags.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p data-testid="edit-summary">{t('sas.flags.edit.summary', { revision: flag.revision, status: statusLabel(t, flag.status) })}</p>
          <p className="sub">{t('sas.flags.edit.notice')}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="edit-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <fieldset>
            <legend>{t('sas.flags.edit.status.label')}</legend>
            {STATUSES.map((value) => (
              <label key={value}>
                <input type="radio" name="flag-status" value={value} checked={form.status === value} onChange={() => set({ status: value })} /> {statusLabel(t, value)}
              </label>
            ))}
          </fieldset>
          {form.status === 'Rollout' ? (
            <>
              <Field id="flag-cohorts" label={t('sas.flags.field.cohorts.label')} error={fieldMessage(t, problems.cohorts)} hint={t('sas.flags.field.cohorts.hint')}>
                <input id="flag-cohorts" type="text" value={form.cohorts} onChange={(event) => set({ cohorts: event.target.value })} />
              </Field>
              <Field id="flag-tenants" label={t('sas.flags.field.tenants.label')} error={fieldMessage(t, problems.tenantIds)} hint={t('sas.flags.field.tenants.hint')}>
                <textarea id="flag-tenants" rows={3} value={form.tenantIds} onChange={(event) => set({ tenantIds: event.target.value })} />
              </Field>
              <Field id="flag-percentage" label={t('sas.flags.field.percentage.label')} error={fieldMessage(t, problems.percentage)} hint={t('sas.flags.field.percentage.hint')}>
                <input id="flag-percentage" type="text" inputMode="numeric" value={form.percentage} onChange={(event) => set({ percentage: event.target.value })} />
              </Field>
            </>
          ) : null}
          <Field id="flag-reason" label={t('sas.flags.field.reason.label')} error={fieldMessage(t, problems.reason)} hint={t('sas.flags.field.reason.hint')}>
            <textarea id="flag-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('sas.flags.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {t('sas.flags.edit.submit.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
