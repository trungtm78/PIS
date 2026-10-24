import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { errorIdOf, hintIdOf, wireControl } from '../field-wiring';
import { useCreateParcel, useCreateSection, useRecordNotice } from './hooks';
import { commandProblemMessage, formProblemMessage, landUseLabel, timerLabel } from './labels';
import {
  EMPTY_NOTICE_FORM,
  EMPTY_PARCEL_FORM,
  EMPTY_SECTION_FORM,
  LAND_USE_GROUPS,
  describeProblem,
  noticeBody,
  noticeTimerOf,
  parcelBody,
  sectionBody,
  validateNotice,
  validateParcel,
  validateSection,
} from './model';
import type { NoticeForm, ParcelForm, ParcelLine, SectionForm, SectionOption, UnitOption } from './model';
import './lnd.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '×';

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
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

interface DialogFrameProps {
  title: string;
  onClose(): void;
  refusal: string | undefined;
  pending: boolean;
  onSubmit(event: FormEvent): void;
  children: ReactNode;
}

/** The frame the three commands share: the title bar, the refusal of the server, the form and its two buttons. */
function DialogFrame({ title, onClose, refusal, pending, onSubmit, children }: DialogFrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="icon-button" aria-label={t('lnd.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="lnd-dialog-body">
          <form onSubmit={onSubmit} noValidate>
            {refusal === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="refusal">
                {refusal}
              </p>
            )}
            <div className="formgrid">{children}</div>
            <div className="formfooter">
              <button type="button" onClick={onClose}>
                {t('lnd.dialog.cancel.action')}
              </button>
              <button type="submit" className="primary" disabled={pending}>
                {pending ? t('lnd.dialog.submit.pending') : t('lnd.dialog.submit.action')}
              </button>
            </div>
          </form>
        </div>
      </section>
    </NavigationDialog>
  );
}

/** The notice of recovery of one parcel: the day it was given and the document that is the notice. The days it starts are the rule of that day, said after. */
export function NoticeDialog({ parcel, today, onClose }: { parcel: ParcelLine; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordNotice();
  const [form, setForm] = useState<NoticeForm>(EMPTY_NOTICE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateNotice(form, today);
  const error = (field: keyof NoticeForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ id: parcel.id, version: parcel.version, body: noticeBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.noticeDialog.title.text', { code: parcel.parcelCode })}
      onClose={onClose}
      refusal={record.isError ? commandProblemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      onSubmit={submit}
    >
      <p data-testid="notice-timer">{t('lnd.noticeDialog.timer.text', { timer: timerLabel(t, noticeTimerOf(parcel.landUseGroup)) })}</p>
      <Field id="notice-on" label={t('lnd.noticeDialog.date.label')} error={error('noticeOn')} hint={t('lnd.noticeDialog.date.help')}>
        <input id="notice-on" type="date" max={today} value={form.noticeOn} onChange={(event) => setForm({ ...form, noticeOn: event.target.value })} />
      </Field>
      <Field id="notice-document" label={t('lnd.noticeDialog.document.label')} error={error('documentVersionId')} hint={t('lnd.noticeDialog.document.help')}>
        <input id="notice-document" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

export interface ParcelDialogProps {
  projectId: string;
  units: readonly UnitOption[];
  sections: readonly SectionOption[];
  onClose(): void;
}

/** The declaration of a parcel. The form has no field for an owner or a user of the land, and the hint under the address says why. */
export function ParcelDialog({ projectId, units, sections, onClose }: ParcelDialogProps) {
  const { t } = useTranslation();
  const create = useCreateParcel();
  const [form, setForm] = useState<ParcelForm>(EMPTY_PARCEL_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateParcel(form);
  const error = (field: keyof ParcelForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate(parcelBody(projectId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.parcelDialog.title.text')}
      onClose={onClose}
      refusal={create.isError ? commandProblemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      onSubmit={submit}
    >
      <Field id="parcel-code" label={t('lnd.parcelDialog.code.label')} error={error('parcelCode')} hint={t('lnd.parcelDialog.code.help')}>
        <input id="parcel-code" value={form.parcelCode} onChange={(event) => setForm({ ...form, parcelCode: event.target.value })} />
      </Field>
      <Field id="parcel-unit" label={t('lnd.parcelDialog.unit.label')} error={error('ownerUnitId')}>
        <select id="parcel-unit" value={form.ownerUnitId} onChange={(event) => setForm({ ...form, ownerUnitId: event.target.value })}>
          <option value="">{t('lnd.parcelDialog.unit.choose')}</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="parcel-land-use" label={t('lnd.parcelDialog.landUse.label')} error={error('landUseGroup')}>
        <select id="parcel-land-use" value={form.landUseGroup} onChange={(event) => setForm({ ...form, landUseGroup: event.target.value as ParcelForm['landUseGroup'] })}>
          <option value="">{t('lnd.parcelDialog.landUse.choose')}</option>
          {LAND_USE_GROUPS.map((group) => (
            <option key={group} value={group}>
              {landUseLabel(t, group)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="parcel-area-total" label={t('lnd.parcelDialog.areaTotal.label')} error={error('areaTotalM2')}>
        <input id="parcel-area-total" inputMode="decimal" value={form.areaTotalM2} onChange={(event) => setForm({ ...form, areaTotalM2: event.target.value })} />
      </Field>
      <Field id="parcel-area-affected" label={t('lnd.parcelDialog.areaAffected.label')} error={error('areaAffectedM2')}>
        <input id="parcel-area-affected" inputMode="decimal" value={form.areaAffectedM2} onChange={(event) => setForm({ ...form, areaAffectedM2: event.target.value })} />
      </Field>
      <Field id="parcel-address" label={t('lnd.parcelDialog.address.label')} error={error('addressText')} hint={t('lnd.parcelDialog.address.help')}>
        <input id="parcel-address" value={form.addressText} onChange={(event) => setForm({ ...form, addressText: event.target.value })} />
      </Field>
      <Field id="parcel-section" label={t('lnd.parcelDialog.section.label')} error={error('sectionId')}>
        <select id="parcel-section" value={form.sectionId} onChange={(event) => setForm({ ...form, sectionId: event.target.value })}>
          <option value="">{t('lnd.parcelDialog.section.none')}</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.code}
            </option>
          ))}
        </select>
      </Field>
    </DialogFrame>
  );
}

/** The creation of a section of a project, by kilometre or by area. */
export function SectionDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const { t } = useTranslation();
  const create = useCreateSection();
  const [form, setForm] = useState<SectionForm>(EMPTY_SECTION_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateSection(form);
  const error = (field: keyof SectionForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate(sectionBody(projectId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.sectionDialog.title.text')}
      onClose={onClose}
      refusal={create.isError ? commandProblemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      onSubmit={submit}
    >
      <Field id="section-code" label={t('lnd.sectionDialog.code.label')} error={error('code')}>
        <input id="section-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      </Field>
      <Field id="section-name" label={t('lnd.sectionDialog.name.label')} error={error('name')}>
        <input id="section-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field id="section-from-km" label={t('lnd.sectionDialog.fromKm.label')} error={error('fromKm')}>
        <input id="section-from-km" inputMode="decimal" value={form.fromKm} onChange={(event) => setForm({ ...form, fromKm: event.target.value })} />
      </Field>
      <Field id="section-to-km" label={t('lnd.sectionDialog.toKm.label')} error={error('toKm')}>
        <input id="section-to-km" inputMode="decimal" value={form.toKm} onChange={(event) => setForm({ ...form, toKm: event.target.value })} />
      </Field>
      <Field id="section-area" label={t('lnd.sectionDialog.area.label')} error={error('requiredAreaM2')}>
        <input id="section-area" inputMode="decimal" value={form.requiredAreaM2} onChange={(event) => setForm({ ...form, requiredAreaM2: event.target.value })} />
      </Field>
      <Field id="section-target" label={t('lnd.sectionDialog.target.label')} error={error('targetDate')}>
        <input id="section-target" type="date" value={form.targetDate} onChange={(event) => setForm({ ...form, targetDate: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
