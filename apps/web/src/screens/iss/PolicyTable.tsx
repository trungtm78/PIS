import { Fragment, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useRetirePolicy } from './hooks';
import { fieldProblemMessage, phaseLabel, problemMessage, severityLabel } from './labels';
import { describeProblem, phaseOf, validateRetireDate } from './model';
import type { FieldProblem, PolicyGroup, PolicyView, UnitOption } from './model';

export interface PolicyTableProps {
  groups: readonly PolicyGroup[];
  units: ReadonlyMap<string, UnitOption>;
  /** The Vietnam date the phases are judged on. */
  today: string;
  /** Whether the caller may end a policy (and the tenant is not frozen). */
  mayRetire: boolean;
}

/**
 * ISS-09: the SLA policies by category, severity and unit. A row is the version that matters now (the one that applies, else the next one,
 * else the last one); its history lists every version, because an issue keeps the version it was created under.
 */
export function PolicyTable({ groups, units, today, mayRetire }: PolicyTableProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<string | undefined>(undefined);
  const [retiring, setRetiring] = useState<string | undefined>(undefined);
  const unitName = (policy: PolicyView): string => (policy.ownerUnitId === null ? t('iss.sla.unit.default.text') : (units.get(policy.ownerUnitId)?.name ?? policy.ownerUnitId));
  const validity = (policy: PolicyView): string => `${policy.validFrom} → ${policy.validUntil ?? ''}`;
  const escalation = (policy: PolicyView): string => t('iss.sla.escalation.cell.text', { l2: policy.escalateL2Pct, l3: policy.escalateL3Pct });

  return (
    <table className="table" aria-label={t('iss.sla.table.aria')}>
      <thead>
        <tr>
          <th>{t('iss.sla.category.column')}</th>
          <th>{t('iss.sla.severity.column')}</th>
          <th>{t('iss.sla.unit.column')}</th>
          <th>{t('iss.sla.calendar.column')}</th>
          <th>{t('iss.sla.response.column')}</th>
          <th>{t('iss.sla.resolve.column')}</th>
          <th>{t('iss.sla.escalation.column')}</th>
          <th>{t('iss.sla.validity.column')}</th>
          <th>{t('iss.sla.status.column')}</th>
          <th>
            <span className="sr-only">{t('iss.sla.actions.column')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const { current } = group;
          const phase = phaseOf(current, today);
          return (
            <Fragment key={group.key}>
              <tr data-group-key={group.key} data-policy-id={current.id} data-phase={phase} data-severity={group.severity}>
                <td>
                  <code>{group.categoryKey}</code> {group.categoryLabel}
                </td>
                <td>{severityLabel(t, group.severity)}</td>
                <td>{unitName(current)}</td>
                <td>{current.calendarCode}</td>
                <td>{current.responseHours}</td>
                <td>{current.resolveHours}</td>
                <td>{escalation(current)}</td>
                <td>{validity(current)}</td>
                <td>
                  <span className={phase === 'inForce' ? 'pill green' : 'pill gray'}>{phaseLabel(t, phase)}</span>
                </td>
                <td className="row-actions">
                  <button type="button" aria-expanded={history === group.key} onClick={() => setHistory((previous) => (previous === group.key ? undefined : group.key))}>
                    {t('iss.sla.history.action')}
                  </button>
                  {mayRetire && current.status === 'ACTIVE' && current.validUntil === null ? (
                    <button type="button" aria-expanded={retiring === current.id} onClick={() => setRetiring((previous) => (previous === current.id ? undefined : current.id))}>
                      {t('iss.sla.retire.action')}
                    </button>
                  ) : null}
                </td>
              </tr>
              {retiring === current.id ? (
                <tr>
                  <td colSpan={10}>
                    <RetireForm policy={current} today={today} onDone={() => setRetiring(undefined)} />
                  </td>
                </tr>
              ) : null}
              {history === group.key ? (
                <tr>
                  <td colSpan={10}>
                    <VersionHistory group={group} today={today} validity={validity} escalation={escalation} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function VersionHistory({ group, today, validity, escalation }: { group: PolicyGroup; today: string; validity: (policy: PolicyView) => string; escalation: (policy: PolicyView) => string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="history" data-group-key={group.key}>
      <h3>{t('iss.sla.history.title', { category: group.categoryKey })}</h3>
      <table className="table" aria-label={t('iss.sla.history.aria')}>
        <thead>
          <tr>
            <th>{t('iss.sla.revision.column')}</th>
            <th>{t('iss.sla.code.column')}</th>
            <th>{t('iss.sla.response.column')}</th>
            <th>{t('iss.sla.resolve.column')}</th>
            <th>{t('iss.sla.escalation.column')}</th>
            <th>{t('iss.sla.rules.column')}</th>
            <th>{t('iss.sla.validity.column')}</th>
            <th>{t('iss.sla.status.column')}</th>
          </tr>
        </thead>
        <tbody>
          {group.versions.map((version) => (
            <tr key={version.id} data-policy-id={version.id} data-revision={version.revision}>
              <td>{version.revision}</td>
              <td>
                <code>{version.code}</code>
              </td>
              <td>{version.responseHours}</td>
              <td>{version.resolveHours}</td>
              <td>{escalation(version)}</td>
              <td>
                {[version.requireIndependentVerifier ? t('iss.sla.rules.verifier.text') : null, version.requireEvidence ? t('iss.sla.rules.evidence.text') : null].filter((rule) => rule !== null).join(' · ')}
              </td>
              <td>{validity(version)}</td>
              <td>{phaseLabel(t, phaseOf(version, today))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RetireForm({ policy, today, onDone }: { policy: PolicyView; today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const retire = useRetirePolicy();
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refused = retire.isError ? describeProblem(retire.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (retire.isPending) return;
    const found = validateRetireDate(until, policy, today);
    setProblem(found);
    if (found !== undefined) return;
    retire.mutate({ id: policy.id, validUntil: until }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={send} noValidate aria-label={t('iss.sla.retire.title', { code: policy.code })}>
      <h3>{t('iss.sla.retire.title', { code: policy.code })}</h3>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      <Field id={`retire-${policy.id}`} label={t('iss.sla.retire.until.label')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)} hint={t('iss.sla.retire.until.hint')}>
        <input
          id={`retire-${policy.id}`}
          type="date"
          value={until}
          aria-invalid={problem !== undefined}
          onChange={(event) => {
            setUntil(event.target.value);
            setProblem(undefined);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="button" onClick={onDone}>
          {t('iss.sla.cancel.action')}
        </button>
        <button type="submit" className="primary" disabled={retire.isPending}>
          {t('iss.sla.retire.confirm.action')}
        </button>
      </div>
    </form>
  );
}
