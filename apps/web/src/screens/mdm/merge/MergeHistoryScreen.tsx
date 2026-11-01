import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../mdm.css';
import { useMerges, useUnmerge } from './hooks';
import { byLabel, mergeStatusLabel, problemMessage, sideLabel, strategyLabel } from './labels';
import { MERGE_PERMISSION, describeMergeProblem } from './model';
import type { Merge, UnmergeAnswer } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
const NONE = '—';

/**
 * MDM-35: the merges of master records and their undoing (ST-MDM-010, MDM 3.1 F5, UAT-AC274, UAT-AC275): for each merge the entry that survived and the one that was merged away (its old key is an alias), how each attribute
 * was settled and by what, how many references were pointed again, and the button to undo it with a reason. When the survivor edited an attribute it took from the other entry, undoing it asks the steward, for each such
 * attribute, to keep the edit or to give the attribute back.
 */
export default function MergeHistoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <HistoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HistoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const merges = useMerges();
  const state = useScreenState({ isLoading: merges.isLoading, error: merges.error, data: merges.data, isEmpty: () => false });
  const list = merges.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.merge.history.title')}</h1>
          <p>{t('mdm.merge.history.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void merges.refetch()}>
        {list.length === 0 ? (
          <p className="card" data-testid="no-merges">
            {t('mdm.merge.history.none')}
          </p>
        ) : (
          list.map((merge) => <MergeCard key={merge.id} merge={merge} mayUnmerge={holds(permissions, MERGE_PERMISSION, mode)} />)
        )}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.merge.history.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function MergeCard({ merge, mayUnmerge }: { merge: Merge; mayUnmerge: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-labelledby={`merge-${merge.id}`} data-merge={merge.id} data-status={merge.status}>
      <h2 id={`merge-${merge.id}`}>{t('mdm.merge.history.heading', { merged: merge.mergedKey, survivor: merge.survivorKey })}</h2>
      <dl>
        <div>
          <dt>{t('mdm.merge.col.status')}</dt>
          <dd>
            <span className={`pill ${merge.status === 'APPLIED' ? 'green' : 'gray'}`}>{mergeStatusLabel(t, merge.status)}</span>
          </dd>
        </div>
        <div>
          <dt>{t('mdm.merge.col.type')}</dt>
          <dd>{merge.masterType}</dd>
        </div>
        <div>
          <dt>{t('mdm.merge.history.alias')}</dt>
          <dd data-testid="alias">
            <code>{merge.mergedKey}</code> {merge.mergedLabel === null ? '' : `(${merge.mergedLabel})`}
          </dd>
        </div>
        <div>
          <dt>{t('mdm.merge.history.repointed')}</dt>
          <dd data-testid="repointed">{merge.repointed}</dd>
        </div>
        <div>
          <dt>{t('mdm.merge.history.reason')}</dt>
          <dd>{merge.reason}</dd>
        </div>
        {merge.status === 'REVERTED' ? (
          <div>
            <dt>{t('mdm.merge.history.revertReason')}</dt>
            <dd data-testid="revert-reason">{merge.revertReason ?? NONE}</dd>
          </div>
        ) : null}
      </dl>
      <div className="tablewrap">
        <table className="table" data-testid="decisions" aria-label={t('mdm.merge.history.decisions')}>
          <thead>
            <tr>
              <th scope="col">{t('mdm.merge.col.attribute')}</th>
              <th scope="col">{t('mdm.merge.history.chosen')}</th>
              <th scope="col">{t('mdm.merge.history.by')}</th>
              <th scope="col">{t('mdm.merge.history.source')}</th>
            </tr>
          </thead>
          <tbody>
            {merge.decisions.map((decision) => (
              <tr key={decision.attribute} data-attribute={decision.attribute} data-chosen={decision.chosen}>
                <td>
                  <code>{decision.attribute}</code>
                </td>
                <td>{sideLabel(t, decision.chosen)}</td>
                <td>{decision.strategy === null ? byLabel(t, decision.by) : `${byLabel(t, decision.by)} · ${strategyLabel(t, decision.strategy)}`}</td>
                <td>{decision.source ?? NONE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mayUnmerge && merge.status === 'APPLIED' ? <UnmergePanel merge={merge} /> : null}
    </section>
  );
}

function UnmergePanel({ merge }: { merge: Merge }) {
  const { t } = useTranslation();
  const send = useUnmerge();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [answers, setAnswers] = useState<Record<string, UnmergeAnswer>>({});
  const failure = send.isError ? describeMergeProblem(send.error) : undefined;
  const open = failure?.reason === 'unmergeConflict' ? failure.attributes : [];
  const unanswered = open.filter((attribute) => answers[attribute] === undefined);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reason.trim().length < 10) {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (send.isPending || unanswered.length > 0) return;
    send.mutate({ merge, reason, answers });
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t('mdm.merge.history.unmerge', { survivor: merge.survivorKey })}>
      <Field id={`unmerge-reason-${merge.id}`} label={t('mdm.merge.history.unmerge.reason')} error={missing ? t('mdm.merge.history.reason.invalid') : undefined}>
        <input id={`unmerge-reason-${merge.id}`} value={reason} aria-invalid={missing} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {open.length === 0 ? null : (
        <fieldset data-testid="unmerge-conflicts">
          <legend>{t('mdm.merge.history.conflicts')}</legend>
          <p className="sub">{t('mdm.merge.history.conflicts.hint')}</p>
          {open.map((attribute) => (
            <div key={attribute} role="radiogroup" aria-label={attribute} data-attribute={attribute}>
              <strong>
                <code>{attribute}</code>
              </strong>
              {(['KEEP', 'REVERT'] as const).map((answer) => (
                <label key={answer}>
                  <input type="radio" name={`answer-${merge.id}-${attribute}`} checked={answers[attribute] === answer} onChange={() => setAnswers((value) => ({ ...value, [attribute]: answer }))} />
                  {answer === 'KEEP' ? t('mdm.merge.history.keep') : t('mdm.merge.history.revert')}
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      )}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="unmerge-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure)}
        </p>
      )}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending || unanswered.length > 0}>
          {t('mdm.merge.history.unmerge.submit')}
        </button>
      </div>
    </form>
  );
}
