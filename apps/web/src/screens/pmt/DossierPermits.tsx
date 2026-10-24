import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useAddPermit } from './dossier-commands';
import { permitFieldMessage, permitProblemMessage, permitStatusLabel, remainingText } from './dossier-labels';
import { EMPTY_ADD_PERMIT, daysRemaining, describePermitProblem, isExpiring, isValidOn, permitLink, statusTone, toAddPermitBody, validateAddPermit } from './dossier-model';
import type { AddPermitField, DossierView, FormErrors, PermitLineView } from './dossier-model';
import { groupTypes, phaseOf } from './model';
import type { PermitTypeView } from './model';
import './pmt.css';

export interface DossierPermitsProps {
  dossier: DossierView;
  /** The versions of the catalogue: a permit is added of a type that applies today. */
  types: readonly PermitTypeView[];
  /** The Vietnam date the permits are judged on. */
  today: string;
  /** Whether the caller may add a permit (and the tenant is not frozen). */
  mayAdd: boolean;
}

/** The statuses in which a type is already held by the dossier: an application on its way, or a permit in force. */
const HELD: readonly string[] = ['PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'EXEMPTED'];

function Validity({ permit, today }: { permit: PermitLineView; today: string }) {
  const { t } = useTranslation();
  if (permit.validFrom === null) return <>{t('pmt.dossier.validity.none.text')}</>;
  const valid = isValidOn(permit, today);
  return (
    <>
      {permit.validFrom} → {permit.noExpiry ? t('pmt.dossier.remaining.none.text') : (permit.validUntil ?? '')}
      {valid ? (
        <>
          {' '}
          <span className={isExpiring(permit, today) ? 'pill warn' : 'pill gray'} data-testid="remaining">
            {remainingText(t, permit.noExpiry ? null : daysRemaining(permit.validUntil, today))}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * The permits of one dossier (PMT-01): each with the version of the permit type it was written under, its number and days in force, the
 * time left, the flag of a type that still waits for its confirmation, and the way into the detail (PMT-02).
 */
export function DossierPermits({ dossier, types, today, mayAdd }: DossierPermitsProps) {
  const { t } = useTranslation();
  const heldCodes = useMemo(() => new Set(dossier.permits.filter((permit) => HELD.includes(permit.status)).map((permit) => permit.permitTypeCode)), [dossier.permits]);
  // A type that applies today and that the dossier does not hold yet: the one version of its code in force.
  const addable = useMemo(
    () =>
      groupTypes(types, today)
        .map((group) => group.current)
        .filter((type) => phaseOf(type, today) === 'inForce' && !heldCodes.has(type.code)),
    [types, today, heldCodes],
  );

  return (
    <div className="card" data-testid="dossier-permits" data-dossier-id={dossier.id}>
      <h2>{t('pmt.dossier.permits.title', { code: dossier.projectCode })}</h2>
      <table className="table" aria-label={t('pmt.dossier.permits.aria')}>
        <thead>
          <tr>
            <th scope="col">{t('pmt.dossier.type.column')}</th>
            <th scope="col">{t('pmt.dossier.permitStatus.column')}</th>
            <th scope="col">{t('pmt.dossier.number.column')}</th>
            <th scope="col">{t('pmt.dossier.validity.column')}</th>
            <th scope="col">{t('pmt.dossier.responsible.column')}</th>
            <th scope="col">
              <span className="sr-only">{t('pmt.dossier.actions.column')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {dossier.permits.map((permit) => (
            <tr key={permit.id} data-permit-id={permit.id} data-status={permit.status}>
              <th scope="row">
                <code>{permit.permitTypeCode}</code> <span className="sub">{t('pmt.dossier.revision.text', { revision: permit.permitTypeRevision })}</span>
                <br />
                {permit.permitTypeName}
                <br />
                <span className="sub">{permit.isRequired ? t('pmt.dossier.required.yes.text') : t('pmt.dossier.optional.text')}</span>
                {permit.cxnRef === null ? null : (
                  <>
                    {' '}
                    <span className="pill warn" data-testid="unconfirmed">
                      {t('pmt.type.unconfirmed.text', { cxn: permit.cxnRef })}
                    </span>
                  </>
                )}
              </th>
              <td>
                <span className={`pill ${statusTone(permit.status)}`}>{permitStatusLabel(t, permit.status)}</span>
              </td>
              <td>{permit.permitNo ?? t('pmt.dossier.number.none.text')}</td>
              <td>
                <Validity permit={permit} today={today} />
              </td>
              <td>{permit.responsible?.displayName ?? t('pmt.dossier.responsible.none.text')}</td>
              <td className="row-actions">
                <Link to={permitLink(permit.id)}>{t('pmt.dossier.detail.action')}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mayAdd ? <AddPermitForm dossierId={dossier.id} addable={addable} /> : null}
    </div>
  );
}

function AddPermitForm({ dossierId, addable }: { dossierId: string; addable: readonly PermitTypeView[] }) {
  const { t } = useTranslation();
  const add = useAddPermit();
  const [form, setForm] = useState(EMPTY_ADD_PERMIT);
  const [errors, setErrors] = useState<FormErrors<AddPermitField>>({});
  const [saved, setSaved] = useState(false);
  const refused = add.isError ? describePermitProblem(add.error) : undefined;

  const setField = (field: AddPermitField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
    if (add.isError) add.reset();
  };
  const error = (field: AddPermitField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : permitFieldMessage(t, problem);
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (add.isPending) return;
    const found = validateAddPermit(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    add.mutate(
      { dossierId, body: toAddPermitBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_ADD_PERMIT);
          setSaved(true);
        },
      },
    );
  };

  if (addable.length === 0) {
    return (
      <p className="sub" data-testid="nothing-to-add">
        {t('pmt.dossier.add.none.text')}
      </p>
    );
  }
  return (
    <form onSubmit={send} noValidate aria-label={t('pmt.dossier.add.aria')}>
      <h3>{t('pmt.dossier.add.title')}</h3>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {permitProblemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="permit-added">
          {t('pmt.dossier.add.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        <Field id="add-type" label={t('pmt.dossier.add.type.label')} error={error('permitTypeId')}>
          <select id="add-type" value={form.permitTypeId} aria-invalid={error('permitTypeId') !== undefined} onChange={(event) => setField('permitTypeId', event.target.value)}>
            <option value="">{t('pmt.dossier.add.type.placeholder')}</option>
            {addable.map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} · {type.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="add-authority" label={t('pmt.dossier.add.authority.label')} error={error('authorityName')}>
          <input id="add-authority" value={form.authorityName} onChange={(event) => setField('authorityName', event.target.value)} />
        </Field>
        <Field id="add-expected" label={t('pmt.dossier.add.expected.label')} error={error('expectedDecisionOn')}>
          <input id="add-expected" type="date" value={form.expectedDecisionOn} onChange={(event) => setField('expectedDecisionOn', event.target.value)} />
        </Field>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={add.isPending}>
          {t('pmt.dossier.add.action')}
        </button>
      </div>
    </form>
  );
}
