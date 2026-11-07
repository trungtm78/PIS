import { Fragment, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field, Pill } from './components';
import { useRetirePermitType } from './hooks';
import { applicabilityText, categoryLabel, fieldProblemMessage, phaseLabel, problemMessage } from './labels';
import { canRetire, describeProblem, phaseOf, validateRetireDate } from './model';
import type { FieldProblem, PermitTypeView, TypeGroup } from './model';

export interface PermitTypeTableProps {
  groups: readonly TypeGroup[];
  /** The Vietnam date the phases are judged on. */
  today: string;
  /** Whether the caller may end a version (and the tenant is not frozen). */
  mayRetire: boolean;
}

const validity = (type: PermitTypeView): string => `${type.effectiveFrom} → ${type.effectiveUntil ?? ''}`;

/** The legal basis with the flag of a version that still waits for its confirmation: a working assumption is never shown as law. */
function LegalBasis({ type }: { type: PermitTypeView }) {
  const { t } = useTranslation();
  return (
    <>
      {type.legalBasis}
      {type.cxnRef === null ? null : (
        <>
          {' '}
          <Pill tone="warn" data-testid="unconfirmed">
            {t('pmt.type.unconfirmed.text', { cxn: type.cxnRef })}
          </Pill>
        </>
      )}
    </>
  );
}

/**
 * PMT-03: the permit types by code. A row is the version that matters now (the one that applies, else the next one, else the last one); its
 * history lists every version, because a permit keeps the version it was written under. A version is never edited: it is ended, and the
 * regulation that replaces it is published as the next revision.
 */
export function PermitTypeTable({ groups, today, mayRetire }: PermitTypeTableProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<string | undefined>(undefined);
  const [retiring, setRetiring] = useState<string | undefined>(undefined);

  return (
    <table className="table" aria-label={t('pmt.type.table.aria')}>
      <thead>
        <tr>
          <th>{t('pmt.type.code.column')}</th>
          <th>{t('pmt.type.name.column')}</th>
          <th>{t('pmt.type.category.column')}</th>
          <th>{t('pmt.type.legalBasis.column')}</th>
          <th>{t('pmt.type.validity.column')}</th>
          <th>{t('pmt.type.applies.column')}</th>
          <th>{t('pmt.type.exempt.column')}</th>
          <th>{t('pmt.type.status.column')}</th>
          <th>
            <span className="sr-only">{t('pmt.type.actions.column')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const { current } = group;
          const phase = phaseOf(current, today);
          return (
            <Fragment key={group.code}>
              <tr data-group-code={group.code} data-type-id={current.id} data-phase={phase}>
                <td>
                  <code>{group.code}</code>
                </td>
                <td>{current.name}</td>
                <td>{categoryLabel(t, current.category)}</td>
                <td>
                  <LegalBasis type={current} />
                </td>
                <td>{validity(current)}</td>
                <td>{applicabilityText(t, current.appliesTo)}</td>
                <td>{current.exemptionAllowed ? t('pmt.type.exempt.yes.text') : t('pmt.type.exempt.no.text')}</td>
                <td>
                  <Pill tone={phase === 'inForce' ? 'green' : 'gray'}>{phaseLabel(t, phase)}</Pill>
                </td>
                <td className="row-actions">
                  <button type="button" aria-expanded={history === group.code} onClick={() => setHistory((previous) => (previous === group.code ? undefined : group.code))}>
                    {t('pmt.type.history.action')}
                  </button>
                  {mayRetire && canRetire(current, today) ? (
                    <button type="button" aria-expanded={retiring === current.id} onClick={() => setRetiring((previous) => (previous === current.id ? undefined : current.id))}>
                      {t('pmt.type.retire.action')}
                    </button>
                  ) : null}
                </td>
              </tr>
              {retiring === current.id ? (
                <tr>
                  <td colSpan={9}>
                    <RetireForm type={current} today={today} onDone={() => setRetiring(undefined)} />
                  </td>
                </tr>
              ) : null}
              {history === group.code ? (
                <tr>
                  <td colSpan={9}>
                    <VersionHistory group={group} today={today} />
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

function VersionHistory({ group, today }: { group: TypeGroup; today: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="history" data-group-code={group.code}>
      <h3>{t('pmt.type.history.title', { code: group.code })}</h3>
      <table className="table" aria-label={t('pmt.type.history.aria')}>
        <thead>
          <tr>
            <th>{t('pmt.type.revision.column')}</th>
            <th>{t('pmt.type.name.column')}</th>
            <th>{t('pmt.type.legalBasis.column')}</th>
            <th>{t('pmt.type.defaults.column')}</th>
            <th>{t('pmt.type.validity.column')}</th>
            <th>{t('pmt.type.status.column')}</th>
          </tr>
        </thead>
        <tbody>
          {group.versions.map((version) => (
            <tr key={version.id} data-type-id={version.id} data-revision={version.revision}>
              <td>{version.revision}</td>
              <td>{version.name}</td>
              <td>
                <LegalBasis type={version} />
              </td>
              <td>
                {[
                  version.defaultValidityMonths === null ? null : t('pmt.type.defaults.validity.text', { months: version.defaultValidityMonths }),
                  version.defaultProcessingDays === null ? null : t('pmt.type.defaults.processing.text', { days: version.defaultProcessingDays }),
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
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

function RetireForm({ type, today, onDone }: { type: PermitTypeView; today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const retire = useRetirePermitType();
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refused = retire.isError ? describeProblem(retire.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (retire.isPending) return;
    const found = validateRetireDate(until, type, today);
    setProblem(found);
    if (found !== undefined) return;
    retire.mutate({ id: type.id, effectiveUntil: until }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={send} noValidate aria-label={t('pmt.type.retire.title', { code: type.code })}>
      <h3>{t('pmt.type.retire.title', { code: type.code })}</h3>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      <Field id={`retire-${type.id}`} label={t('pmt.type.retire.until.label')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)} hint={t('pmt.type.retire.until.hint')}>
        <input
          id={`retire-${type.id}`}
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
          {t('pmt.type.cancel.action')}
        </button>
        <button type="submit" className="primary" disabled={retire.isPending}>
          {t('pmt.type.retire.confirm.action')}
        </button>
      </div>
    </form>
  );
}
