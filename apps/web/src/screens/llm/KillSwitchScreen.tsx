import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { EMERGENCY, EMPTY_ENGAGE, KILL_SCOPES, MIN_REASON, validateEngage } from './emergency-model';
import type { EngageErrors, EngageValues, KillScope, KillSwitchEntry } from './emergency-model';
import { engageProblemMessage, killScopeLabel, killStateLabel } from './eval-labels';
import { useEngageKillSwitch, useKillSwitches, useReleaseKillSwitch } from './hooks';
import { refusalMessage } from './labels';
import { describeLlmProblem, vietnamDay } from './llm-model';
import { unchanged } from '../unsent';
import './llm-kit.css';

/**
 * LLM-18: the emergency stop of the AI gateway (ST-LLM-006, LLM F7, BR-LLM-12): the switches there are, by scope (the whole tenant, a provider, a model, a profile or a task), why each was engaged and by whom, how many requests it
 * stopped, and, for those that were released, who released them and why. Engaging one stops new requests at once and cancels what was running; a request that was sent to a provider that cannot cancel has its answer thrown away. A
 * switch is released only by another person than the one who engaged it, with a reason. Nothing here shows what was asked or answered.
 */
export default function KillSwitchScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <KillSwitchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function KillSwitchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(EMERGENCY)) && mode !== 'READ_ONLY';
  const switches = useKillSwitches();
  const state = useScreenState({ isLoading: switches.isLoading, error: switches.error, data: switches.data === undefined ? undefined : { rows: switches.data } });
  const engaged = (switches.data ?? []).filter((entry) => entry.state === 'ENGAGED');
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.emergency.page.title')}</h1>
          <p>{t('llm.emergency.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void switches.refetch()}>
        {engaged.length === 0 ? (
          <p className="callout" role="status" data-testid="emergency-clear">
            {t('llm.emergency.clear')}
          </p>
        ) : (
          <p className="callout warning" role="alert" data-testid="emergency-engaged">
            {t('llm.emergency.engagedCount', { count: engaged.length })}
          </p>
        )}
        <div className="tablewrap" role="region" aria-label={t('llm.emergency.table.aria')} tabIndex={0}>
          <table className="table" data-testid="switch-table" aria-label={t('llm.emergency.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.emergency.column.scope')}</th>
                <th scope="col">{t('llm.emergency.column.reason')}</th>
                <th scope="col">{t('llm.emergency.column.engaged')}</th>
                <th scope="col">{t('llm.emergency.column.affected')}</th>
                <th scope="col">{t('llm.emergency.column.state')}</th>
                <th scope="col">{t('llm.emergency.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {(switches.data ?? []).map((entry) => (
                <SwitchRow key={entry.id} entry={entry} may={may} />
              ))}
            </tbody>
          </table>
        </div>
        {(switches.data ?? []).length === 0 ? <p data-testid="switches-none">{t('llm.emergency.none')}</p> : null}
        {may ? <EngageForm /> : null}
      </StateBoundary>
    </section>
  );
}

function SwitchRow({ entry, may }: { entry: KillSwitchEntry; may: boolean }) {
  const { t } = useTranslation();
  const release = useReleaseKillSwitch();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [short, setShort] = useState(false);
  const refused = release.isError ? describeLlmProblem(release.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (release.isPending) return;
    if (reason.trim().length < MIN_REASON) {
      setShort(true);
      return;
    }
    release.mutate({ switchId: entry.id, version: entry.version, reason }, { onSuccess: () => setAsking(false) });
  };
  return (
    <>
      <tr data-switch-id={entry.id} data-state={entry.state} data-scope={entry.scope}>
        <td>
          {killScopeLabel(t, entry.scope)}
          {entry.scopeRef === null ? null : <span className="sub"> · {entry.scopeRef}</span>}
        </td>
        <td>{entry.reason}</td>
        <td>
          {vietnamDay(entry.engagedAt)} <span className="sub">{entry.engagedBy.slice(0, 8)}</span>
        </td>
        <td>{entry.affected}</td>
        <td>
          {killStateLabel(t, entry.state)}
          {entry.state === 'RELEASED' ? (
            <span className="sub">
              {' '}
              · {entry.releasedAt === null ? '' : vietnamDay(entry.releasedAt)} {entry.releasedBy?.slice(0, 8) ?? ''} · {entry.releaseReason ?? ''}
            </span>
          ) : null}
        </td>
        <td>
          {may && entry.state === 'ENGAGED' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={asking} onClick={() => setAsking(!asking)}>
              {t('llm.emergency.release')}
            </button>
          ) : null}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="release-refused">
              {refusalMessage(t, refused.reason, refused.detail)}
            </p>
          )}
        </td>
      </tr>
      {asking && entry.state === 'ENGAGED' ? (
        <tr data-release-for={entry.id}>
          <td colSpan={6}>
            <form onSubmit={send} noValidate aria-label={t('llm.emergency.release.title')}>
              <p className="sub">{t('llm.emergency.release.hint')}</p>
              <Field id={`release-${entry.id}`} label={t('llm.emergency.release.reason')} error={short ? t('llm.emergency.problem.shortReason', { count: MIN_REASON }) : undefined}>
                <input
                  id={`release-${entry.id}`}
                  value={reason}
                  maxLength={2000}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setShort(false);
                  }}
                />
              </Field>
              <div className="mne-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={release.isPending}>
                  {t('llm.emergency.release.submit')}
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EngageForm() {
  const { t } = useTranslation();
  const engage = useEngageKillSwitch();
  const [values, setValues] = useState<EngageValues>(EMPTY_ENGAGE);
  const [errors, setErrors] = useState<EngageErrors>({});
  const [confirmed, setConfirmed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  const refused = engage.isError ? describeLlmProblem(engage.error) : undefined;
  const set = <K extends keyof EngageValues>(field: K, value: EngageValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof EngageErrors): string | undefined => (errors[field] === undefined ? undefined : engageProblemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (engage.isPending) return;
    const found = validateEngage(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // An emergency stop is not made by a slip of the hand: the person says that they know what it stops.
    if (!confirmed) {
      setUnconfirmed(true);
      return;
    }
    engage.mutate(values, {
      onSuccess: () => {
        // What was typed for the next stop while this one was being engaged was never sent, and stays; the confirmation was for the stop that was sent, so the next one is confirmed again.
        if (unchanged(latest.current, values)) setValues(EMPTY_ENGAGE);
        setConfirmed(false);
      },
    });
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.emergency.form.title')}>
      <h2>{t('llm.emergency.form.title')}</h2>
      <p className="sub">{t('llm.emergency.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="engage-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {engage.isSuccess ? (
        <p className="callout" role="status" data-testid="engage-done">
          {t('llm.emergency.form.done')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="kill-scope" label={t('llm.emergency.form.scope')} error={undefined}>
          <select
            id="kill-scope"
            value={values.scope}
            onChange={(event) => {
              setValues((previous) => ({ ...previous, scope: event.target.value as KillScope, scopeRef: '' }));
              setErrors({});
            }}
          >
            {KILL_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {killScopeLabel(t, scope)}
              </option>
            ))}
          </select>
        </Field>
        {values.scope === 'TENANT' ? null : (
          <Field
            id="kill-ref"
            label={t('llm.emergency.form.ref')}
            error={message('scopeRef')}
            hint={values.scope === 'PROVIDER' || values.scope === 'MODEL' ? t('llm.emergency.form.refId') : t('llm.emergency.form.refName')}
          >
            <input id="kill-ref" value={values.scopeRef} maxLength={120} onChange={(event) => set('scopeRef', event.target.value)} />
          </Field>
        )}
      </div>
      <Field id="kill-reason" label={t('llm.emergency.form.reason')} error={message('reason')}>
        <textarea id="kill-reason" rows={3} value={values.reason} maxLength={2000} onChange={(event) => set('reason', event.target.value)} />
      </Field>
      <label className="field" htmlFor="kill-confirm">
        <input
          id="kill-confirm"
          type="checkbox"
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.target.checked);
            setUnconfirmed(false);
          }}
        />{' '}
        {t('llm.emergency.form.confirm')}
      </label>
      {unconfirmed ? (
        <p className="callout warning" role="alert" data-testid="engage-unconfirmed">
          {t('llm.emergency.form.unconfirmed')}
        </p>
      ) : null}
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={engage.isPending}>
          {t('llm.emergency.form.submit')}
        </button>
      </div>
    </form>
  );
}
