import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { classificationLabel, fieldProblemMessage } from './labels';
import { CLASSIFICATIONS } from './model';
import type { FieldProblem, GroupSuggestion, MasterOption, MasterRef, ProjectField, ProjectForm, UnitOption } from './model';
import { StatusPill } from '../../ui';
import './prj.css';

/** The link above the title that the mockup of a detail screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="prj-back-link">
      <Link to={to}>
        <span aria-hidden="true">← </span>
        {children}
      </Link>
    </p>
  );
}

export interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

export function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {wireControl(children, id, { hint: hint !== undefined, error: error !== undefined })}
      {hint === undefined ? null : (
        <small className="sub" id={hintIdOf(id)}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={errorIdOf(id)}>
          {error}
        </small>
      )}
    </div>
  );
}

/** The national project code, or a textual badge when the project has none (a state is never told by colour alone). */
export function NationalCode({ code }: { code: string | null }) {
  const { t } = useTranslation();
  return code === null ? (
    <span data-testid="national-code-missing">
      <StatusPill tone="warning">{t('prj.nationalCode.missing.badge')}</StatusPill>
    </span>
  ) : (
    <code data-testid="national-code">{code}</code>
  );
}

/** The group the rule data suggests, the rule it came from, and the badge that a rule waiting for its confirmation must carry. */
export function SuggestionPanel({ suggestion }: { suggestion: GroupSuggestion | null }) {
  const { t } = useTranslation();
  if (suggestion === null) {
    return (
      <p className="muted" data-testid="suggestion-none">
        {t('prj.suggestion.none.text')}
      </p>
    );
  }
  return (
    <div data-testid="suggestion">
      <p>
        {t('prj.suggestion.group.text', { group: suggestion.groupKey, date: suggestion.asOf })}{' '}
        {suggestion.awaitingConfirmation ? (
          <span data-testid="suggestion-awaiting">
            <StatusPill tone="warning">{suggestion.cxn === null ? t('prj.suggestion.awaiting.badge') : t('prj.suggestion.awaitingCxn.badge', { cxn: suggestion.cxn })}</StatusPill>
          </span>
        ) : null}
      </p>
      <p className="sub">{t('prj.suggestion.basis.text', { basis: suggestion.legalBasis, revision: suggestion.ruleRevision })}</p>
    </div>
  );
}

/** The options of a master select, with the entry the project holds now even when it is no longer in force (so the select can show it). */
export function optionsWith(options: readonly MasterOption[], current: MasterRef | null, masterType: string): MasterOption[] {
  if (current === null || options.some((option) => option.versionId === current.versionId)) return [...options];
  return [...options, { versionId: current.versionId, masterType, businessKey: current.businessKey, label: current.label }];
}

export interface FormFieldsProps {
  mode: 'create' | 'profile';
  form: ProjectForm;
  errors: Partial<Record<ProjectField, FieldProblem>>;
  onChange: (field: ProjectField, value: string) => void;
  units: readonly UnitOption[];
  areas: readonly MasterOption[];
  sectors: readonly MasterOption[];
  projectTypes: readonly MasterOption[];
  programs: readonly MasterOption[];
  disabled: boolean;
  /** The fields of the dossier are past the stage in which they change; only a revision decided by the authority moves them. */
  dossierLocked?: boolean;
}

function MasterSelect({
  id,
  value,
  options,
  disabled,
  onChange,
  optional,
}: {
  id: string;
  value: string;
  options: readonly MasterOption[];
  disabled: boolean;
  onChange: (value: string) => void;
  optional: boolean;
}) {
  const { t } = useTranslation();
  return (
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {optional || value === '' ? <option value="">{t('prj.form.choose.option')}</option> : null}
      {options.map((option) => (
        <option key={option.versionId} value={option.versionId}>
          {option.businessKey} · {option.label}
        </option>
      ))}
    </select>
  );
}

function UnitSelect({ id, value, units, disabled, onChange, optional }: { id: string; value: string; units: readonly UnitOption[]; disabled: boolean; onChange: (value: string) => void; optional: boolean }) {
  const { t } = useTranslation();
  return (
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {optional || value === '' ? <option value="">{t('prj.form.choose.option')}</option> : null}
      {units.map((unit) => (
        <option key={unit.id} value={unit.id}>
          {unit.code} · {unit.name}
        </option>
      ))}
    </select>
  );
}

/** The fields of the project form: the whole dossier when a project is created, the profile (within its allowlist) when it is changed. */
export function ProjectFormFields({ mode, form, errors, onChange, units, areas, sectors, projectTypes, programs, disabled, dossierLocked = false }: FormFieldsProps) {
  const { t } = useTranslation();
  const error = (field: ProjectField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };
  const governed = disabled || dossierLocked;
  return (
    <>
      <fieldset disabled={disabled} className="formgrid">
        {mode === 'create' ? (
          <Field id="project-code" label={t('prj.form.code.label')} error={error('code')} hint={t('prj.form.code.hint')}>
            <input id="project-code" value={form.code} aria-invalid={error('code') !== undefined} onChange={(event) => onChange('code', event.target.value)} />
          </Field>
        ) : null}
        <Field id="project-name" label={t('prj.form.name.label')} error={error('name')}>
          <input id="project-name" value={form.name} aria-invalid={error('name') !== undefined} onChange={(event) => onChange('name', event.target.value)} />
        </Field>
        <Field id="project-classification" label={t('prj.form.classification.label')} error={undefined}>
          <select id="project-classification" value={form.classification} onChange={(event) => onChange('classification', event.target.value)}>
            {CLASSIFICATIONS.map((classification) => (
              <option key={classification} value={classification}>
                {classificationLabel(t, classification)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      {dossierLocked ? (
        <p className="callout" role="status" data-testid="dossier-locked">
          {t('prj.form.dossierLocked.notice')}
        </p>
      ) : null}
      <fieldset disabled={governed} className="formgrid">
        {mode === 'create' ? (
          <Field id="project-ownerUnitId" label={t('prj.form.owner.label')} error={error('ownerUnitId')}>
            <UnitSelect id="project-ownerUnitId" value={form.ownerUnitId} units={units} disabled={governed} optional={false} onChange={(value) => onChange('ownerUnitId', value)} />
          </Field>
        ) : null}
        <Field id="project-investorUnitId" label={t('prj.form.investor.label')} error={error('investorUnitId')} hint={mode === 'create' ? t('prj.form.investor.hint') : undefined}>
          <UnitSelect id="project-investorUnitId" value={form.investorUnitId} units={units} disabled={governed} optional onChange={(value) => onChange('investorUnitId', value)} />
        </Field>
        {mode === 'create' ? (
          <Field id="project-decisionAuthorityUnitId" label={t('prj.form.authority.label')} error={undefined}>
            <UnitSelect id="project-decisionAuthorityUnitId" value={form.decisionAuthorityUnitId} units={units} disabled={governed} optional onChange={(value) => onChange('decisionAuthorityUnitId', value)} />
          </Field>
        ) : null}
        <Field id="project-areaVersionId" label={t('prj.form.area.label')} error={error('areaVersionId')}>
          <MasterSelect id="project-areaVersionId" value={form.areaVersionId} options={areas} disabled={governed} optional={false} onChange={(value) => onChange('areaVersionId', value)} />
        </Field>
        <Field id="project-sectorVersionId" label={t('prj.form.sector.label')} error={undefined}>
          <MasterSelect id="project-sectorVersionId" value={form.sectorVersionId} options={sectors} disabled={governed} optional onChange={(value) => onChange('sectorVersionId', value)} />
        </Field>
        <Field id="project-projectTypeVersionId" label={t('prj.form.projectType.label')} error={undefined}>
          <MasterSelect id="project-projectTypeVersionId" value={form.projectTypeVersionId} options={projectTypes} disabled={governed} optional onChange={(value) => onChange('projectTypeVersionId', value)} />
        </Field>
        <Field id="project-programVersionId" label={t('prj.form.program.label')} error={undefined}>
          <MasterSelect id="project-programVersionId" value={form.programVersionId} options={programs} disabled={governed} optional onChange={(value) => onChange('programVersionId', value)} />
        </Field>
        {mode === 'create' ? (
          <Field id="project-totalInvestment" label={t('prj.form.total.label')} error={error('totalInvestment')} hint={t('prj.form.total.hint')}>
            <input
              id="project-totalInvestment"
              inputMode="numeric"
              value={form.totalInvestment}
              aria-invalid={error('totalInvestment') !== undefined}
              onChange={(event) => onChange('totalInvestment', event.target.value)}
            />
          </Field>
        ) : null}
        <Field id="project-startYear" label={t('prj.form.startYear.label')} error={error('startYear')}>
          <input id="project-startYear" inputMode="numeric" value={form.startYear} aria-invalid={error('startYear') !== undefined} onChange={(event) => onChange('startYear', event.target.value)} />
        </Field>
        <Field id="project-endYear" label={t('prj.form.endYear.label')} error={error('endYear')}>
          <input id="project-endYear" inputMode="numeric" value={form.endYear} aria-invalid={error('endYear') !== undefined} onChange={(event) => onChange('endYear', event.target.value)} />
        </Field>
      </fieldset>
    </>
  );
}
