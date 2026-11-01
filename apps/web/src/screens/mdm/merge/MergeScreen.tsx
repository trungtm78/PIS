import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { useRecords, useTypePolicies } from '../hooks';
import type { RecordView } from '../model';
import '../mdm.css';
import { useMergeRecords } from './hooks';
import { problemMessage } from './labels';
import { EMPTY_MERGE, MERGE_PERMISSION, describeMergeProblem, validateMerge } from './model';
import type { FormProblem, MergeField, MergeForm, Overrides, Side } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
const NONE = '—';

/** What an entry says of an attribute (`label` is the name of the entry itself), as text. */
function valueOf(record: RecordView | undefined, attribute: string): string {
  if (record === undefined) return NONE;
  // The kernel keys an attribute called `label`, or one that starts with `~`, with one more `~`.
  const value = attribute === 'label' ? record.label : record.attributes[attribute.startsWith('~') ? attribute.slice(1) : attribute];
  return value === undefined || value === null || value === '' ? NONE : typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * MDM-30: merging two entries of a type into one (ST-MDM-010, MDM 3.1 F5, BR-MDM-05): the survivor and the entry that is merged into it, the reason, and the rules of survivorship settle each attribute. What no rule settles is
 * shown with the value of each entry, and the steward chooses; the merge can be undone from MDM-35. An entry made by the person who merges, or an entry of the platform, cannot be merged by them (the server says so).
 */
export default function MergeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <MergeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MergeContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const policies = useTypePolicies();
  const [type, setType] = useState('');
  const state = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data, isEmpty: () => false });
  const types = (policies.data ?? []).filter((policy) => !policy.locked && policy.tenantRecords > 1);
  const chosen = type !== '' ? type : types[0]?.masterType;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.merge.merge.title')}</h1>
          <p>{t('mdm.merge.merge.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        {chosen === undefined ? (
          <p className="card" data-testid="no-types">
            {t('mdm.merge.merge.noTypes')}
          </p>
        ) : (
          <>
            <Field id="merge-type" label={t('mdm.merge.col.type')} error={undefined}>
              <select id="merge-type" value={chosen} onChange={(event) => setType(event.target.value)}>
                {types.map((policy) => (
                  <option key={policy.masterType} value={policy.masterType}>
                    {policy.masterType}
                  </option>
                ))}
              </select>
            </Field>
            <MergePanel key={chosen} masterType={chosen} mayMerge={holds(permissions, MERGE_PERMISSION, mode)} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.merge.merge.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function MergePanel({ masterType, mayMerge }: { masterType: string; mayMerge: boolean }) {
  const { t } = useTranslation();
  const records = useRecords(masterType);
  const send = useMergeRecords();
  const [form, setForm] = useState<MergeForm>(EMPTY_MERGE);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [problems, setProblems] = useState<Partial<Record<MergeField, FormProblem>>>({});
  const [done, setDone] = useState<number | undefined>(undefined);
  const state = useScreenState({ isLoading: records.isLoading, error: records.error, data: records.data, isEmpty: () => false });
  const entries = (records.data ?? []).filter((record) => record.status === 'EFFECTIVE' && record.namespace === 'TENANT');
  const survivor = entries.find((record) => record.id === form.survivorId);
  const merged = entries.find((record) => record.id === form.mergedId);
  const failure = send.isError ? describeMergeProblem(send.error) : undefined;
  const set = (patch: Partial<MergeForm>): void => {
    setForm((value) => ({ ...value, ...patch }));
    setOverrides({});
    setDone(undefined);
    send.reset();
  };
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('mdm.merge.form.required') : invalid);
  /** The attributes the server could not settle by a rule: each needs a side before the merge is sent again. */
  const open = failure?.reason === 'conflict' ? failure.attributes : [];
  const unanswered = open.filter((attribute) => overrides[attribute] === undefined);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setDone(undefined);
    const found = validateMerge(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending || survivor === undefined || unanswered.length > 0) return;
    send.mutate(
      { form, survivorVersion: survivor.version, overrides },
      {
        onSuccess: (answer) => {
          const count = (answer as { repointed?: unknown } | undefined)?.repointed;
          setDone(typeof count === 'number' ? count : 0);
          setForm(EMPTY_MERGE);
          setOverrides({});
        },
      },
    );
  };

  return (
    <StateBoundary state={state} onRetry={() => void records.refetch()}>
      <form className="card" onSubmit={submit} noValidate aria-label={t('mdm.merge.merge.form')}>
        <Field id="merge-survivor" label={t('mdm.merge.merge.survivor')} hint={t('mdm.merge.merge.survivor.hint')} error={message(problems.survivorId, '')}>
          <select id="merge-survivor" value={form.survivorId} aria-invalid={problems.survivorId !== undefined} onChange={(event) => set({ survivorId: event.target.value })}>
            <option value="" />
            {entries.map((record) => (
              <option key={record.id} value={record.id}>{`${record.businessKey} · ${record.label ?? NONE}`}</option>
            ))}
          </select>
        </Field>
        <Field id="merge-merged" label={t('mdm.merge.merge.merged')} hint={t('mdm.merge.merge.merged.hint')} error={message(problems.mergedId, t('mdm.merge.merge.merged.same'))}>
          <select id="merge-merged" value={form.mergedId} aria-invalid={problems.mergedId !== undefined} onChange={(event) => set({ mergedId: event.target.value })}>
            <option value="" />
            {entries.map((record) => (
              <option key={record.id} value={record.id}>{`${record.businessKey} · ${record.label ?? NONE}`}</option>
            ))}
          </select>
        </Field>
        <Field id="merge-reason" label={t('mdm.merge.merge.reason')} error={message(problems.reason, t('mdm.merge.merge.reason.invalid'))}>
          <input id="merge-reason" value={form.reason} aria-invalid={problems.reason !== undefined} onChange={(event) => setForm((value) => ({ ...value, reason: event.target.value }))} />
        </Field>
        {open.length === 0 ? null : (
          <fieldset data-testid="conflicts">
            <legend>{t('mdm.merge.merge.conflicts')}</legend>
            <p className="sub">{t('mdm.merge.merge.conflicts.hint')}</p>
            {open.map((attribute) => (
              <div key={attribute} role="radiogroup" aria-label={attribute} data-attribute={attribute}>
                <strong>
                  <code>{attribute}</code>
                </strong>
                {(['SURVIVOR', 'MERGED'] as const satisfies readonly Side[]).map((side) => (
                  <label key={side}>
                    <input type="radio" name={`override-${attribute}`} checked={overrides[attribute] === side} onChange={() => setOverrides((value) => ({ ...value, [attribute]: side }))} />
                    {side === 'SURVIVOR' ? t('mdm.merge.merge.take.survivor', { value: valueOf(survivor, attribute) }) : t('mdm.merge.merge.take.merged', { value: valueOf(merged, attribute) })}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
        )}
        {failure === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="merge-refusal" data-reason={failure.reason}>
            {problemMessage(t, failure)}
          </p>
        )}
        {done === undefined ? null : (
          <p className="callout" role="status" data-testid="merge-done">
            {t('mdm.merge.merge.done', { count: done })}
          </p>
        )}
        {mayMerge ? (
          <div className="formfooter">
            <button type="submit" className="primary" disabled={send.isPending || unanswered.length > 0}>
              {t('mdm.merge.merge.submit')}
            </button>
          </div>
        ) : null}
      </form>
    </StateBoundary>
  );
}
