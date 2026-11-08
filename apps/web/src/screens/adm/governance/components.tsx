import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog, StatusPill, UnitChip } from '../../../ui';
import { KitTable } from '../KitTable';
import { useRuleMove } from './hooks';
import { alertFieldText, blockText, legalText, moveRule, moveTitle, moveText, phaseLook, phaseText, problemText, reasonLabel, refusalText, severityText, statusText, unitText } from './labels';
import type { Translate } from './labels';
import { ALERT_TYPE, REASON_MAX, REASON_MIN, blankDraft, dayText, describeRefusal, momentText, shortId, sideBySide, unitOfField, updateAt } from './model';
import type { Draft, FieldSpec, LegalStatus, Move, Problem, Refusal, RuleVersion, Schema } from './model';
import './governance.css';

// ---- Small pieces ------------------------------------------------------------------------------------------------------------------------------------------------

/** "Unverified": the numbers were not confirmed with the law or the customer. Text and glyph, never colour alone. */
export function LegalChip({ status }: { status: LegalStatus }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={status === 'UNVERIFIED' ? 'warning' : 'success'} icon={status === 'UNVERIFIED' ? '⚠' : '✔'}>
      {legalText(t, status)}
    </StatusPill>
  );
}

/** The state of a version in words: its status, and where it stands on the calendar when it was approved. */
export function VersionPill({ version }: { version: Pick<RuleVersion, 'status' | 'phase'> }) {
  const { t } = useTranslation();
  const look = phaseLook(version.phase);
  const label = version.status === 'APPROVED' || version.status === 'RETIRED' ? `${statusText(t, version.status)} · ${phaseText(t, version.phase)}` : statusText(t, version.status);
  return (
    <StatusPill tone={look.tone} icon={look.icon}>
      {label}
    </StatusPill>
  );
}

export function periodText(t: Translate, from: string, to: string | null): string {
  return to === null ? t('gova1.period.open', { from: dayText(from) }) : t('gova1.period.closed', { from: dayText(from), to: dayText(to) });
}

/** The person as the page can name them: "You" for the person who is signed in, else the start of the membership id (the audit log, ADM-11, names the person). */
export function personText(t: Translate, id: string | null, me: string | undefined): string {
  if (id === null || id === '') return t('gova1.common.none');
  return id === me ? t('gova1.common.you') : shortId(id);
}

/** The value of a param as text: yes/no, a number with its thousands, the text as it is; a list or object as compact JSON. */
export function valueText(t: Translate, locale: string, value: unknown, present = true): string {
  if (!present) return t('gova1.common.absent');
  if (value === null || value === undefined) return t('gova1.common.absent');
  if (typeof value === 'boolean') return value ? t('gova1.common.yes') : t('gova1.common.no');
  if (typeof value === 'number') return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  if (typeof value === 'string') return value === '' ? t('gova1.common.emptyText') : value;
  return JSON.stringify(value);
}

/** The number with its unit when the field name says one ("Unit: hours"); a plain value otherwise. */
export function FieldValue({ path, value, present = true }: { path: string; value: unknown; present?: boolean }) {
  const { t, locale } = useTranslation();
  const unit = typeof value === 'number' ? unitOfField(path) : null;
  return (
    <span className="gova1-value">
      {valueText(t, locale, value, present)}
      {unit === null ? null : <span className="gova1-unit"> {unitText(t, unit)}</span>}
    </span>
  );
}

// ---- The rule in force beside the default that ships ------------------------------------------------------------------------------------------------------------

export interface SideBySideProps {
  caption: string;
  leftLabel: string;
  rightLabel: string;
  left: Record<string, unknown> | undefined;
  right: Record<string, unknown> | undefined;
}

/** Each param on its own row with both values; a row that differs is marked with a glyph and the words "differs from the default" (not colour alone). */
export function SideBySide({ caption, leftLabel, rightLabel, left, right }: SideBySideProps) {
  const { t } = useTranslation();
  const rows = sideBySide(left, right);
  if (rows.length === 0) return <p className="adm-kit-empty">{t('gova1.compare.empty')}</p>;
  return (
    <KitTable caption={caption} testId="side-by-side">
      <thead>
        <tr>
          <th scope="col">{t('gova1.compare.param')}</th>
          <th scope="col">{leftLabel}</th>
          <th scope="col">{rightLabel}</th>
          <th scope="col">{t('gova1.compare.mark')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path} data-param={row.path} data-same={row.same ? 'yes' : 'no'}>
            <th scope="row" className="gova1-path">
              {row.path}
            </th>
            <td>
              <FieldValue path={row.path} value={row.left} present={row.hasLeft} />
            </td>
            <td>
              <FieldValue path={row.path} value={row.right} present={row.hasRight} />
            </td>
            <td>
              {row.same ? (
                <span className="gova1-mark gova1-mark--same">{t('gova1.compare.same')}</span>
              ) : (
                <span className="gova1-mark gova1-mark--differs">
                  <span aria-hidden="true">≠ </span>
                  {t('gova1.compare.differs')}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </KitTable>
  );
}

// ---- The form generated from the schema -----------------------------------------------------------------------------------------------------------------------

export interface ParamsFormProps {
  ruleType: string;
  schema: Schema;
  draft: Draft;
  onChange: (draft: Draft) => void;
  problems: readonly Problem[];
  disabled?: boolean;
  idPrefix?: string;
}

const idOf = (prefix: string, path: string): string => `${prefix}-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
const SEVERITIES = new Set(['URGENT', 'ACTION', 'WATCH']);

function enumLabel(t: Translate, value: string): string {
  return SEVERITIES.has(value) ? severityText(t, value as 'URGENT' | 'ACTION' | 'WATCH') : value;
}

function hintOf(t: Translate, spec: FieldSpec): string | undefined {
  switch (spec.kind) {
    case 'int':
    case 'number':
      return t('gova1.hint.range', { min: spec.min, max: spec.max });
    case 'text':
      return t('gova1.hint.length', { max: spec.max });
    case 'time':
      return t('gova1.hint.time');
    case 'list':
      return t('gova1.hint.listSize', { min: spec.min ?? 0, max: spec.max });
    default:
      return undefined;
  }
}

/**
 * A typed form built from the schema of the rule type (G0-1): a number is a number with its range and unit, a day is a day, a choice is a list, a list has its own add and remove, an object is a group. The
 * message of each field is the one of the schema (`required`, `range`, …) and is written next to the field with a glyph and at the head of the page; the server judges again and names the field it refuses.
 */
export function ParamsForm({ ruleType, schema, draft, onChange, problems, disabled = false, idPrefix = 'gova1-p' }: ParamsFormProps) {
  const { t } = useTranslation();
  const byPath = new Map<string, Problem>();
  for (const problem of problems) if (!byPath.has(problem.path)) byPath.set(problem.path, problem);

  const renderField = (name: string, spec: FieldSpec, path: string, trail: Array<string | number>, value: Draft | undefined, label: string): ReactNode => {
    const problem = byPath.get(path);
    const id = idOf(idPrefix, path);
    const describedBy = [problem === undefined ? '' : `${id}-error`, `${id}-hint`].filter(Boolean).join(' ');
    const unit = spec.kind === 'int' || spec.kind === 'number' ? unitOfField(path) : null;
    const set = (next: Draft): void => onChange(updateAt(draft, trail, next));
    const head = (
      <>
        <span>{label}</span>
        {spec.optional === true ? <span className="gova1-optional"> ({t('gova1.form.optional')})</span> : null}
        {unit === null ? null : <UnitChip unit={unitText(t, unit)} />}
      </>
    );
    const message = problem === undefined ? null : (
      <span className="gova1-error" id={`${id}-error`} data-testid={`error-${path}`}>
        <span aria-hidden="true">⚠ </span>
        {problemText(t, problem)}
      </span>
    );
    const hint = hintOf(t, spec);
    const hintNode = hint === undefined ? null : (
      <span className="gova1-hint" id={`${id}-hint`}>
        {hint}
      </span>
    );
    const common = { id, disabled, 'aria-invalid': problem !== undefined, 'aria-describedby': describedBy === '' ? undefined : describedBy, 'data-testid': `field-${path}` } as const;

    switch (spec.kind) {
      case 'boolean':
        return (
          <div className="gova1-field gova1-field--check" key={path}>
            <label htmlFor={id}>
              <input {...common} type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
              <span> {head}</span>
            </label>
          </div>
        );
      case 'enum':
        return (
          <div className="gova1-field" key={path}>
            <label htmlFor={id}>{head}</label>
            <select {...common} value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)}>
              <option value="">{t('gova1.form.choose')}</option>
              {spec.values.map((option) => (
                <option key={option} value={option}>
                  {enumLabel(t, option)}
                </option>
              ))}
            </select>
            {message}
          </div>
        );
      case 'int':
      case 'number':
        return (
          <div className="gova1-field" key={path}>
            <label htmlFor={id}>{head}</label>
            <input {...common} type="text" inputMode={spec.kind === 'int' ? 'numeric' : 'decimal'} autoComplete="off" value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)} />
            {hintNode}
            {message}
          </div>
        );
      case 'date':
        return (
          <div className="gova1-field" key={path}>
            <label htmlFor={id}>{head}</label>
            <input {...common} type="date" value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)} />
            {message}
          </div>
        );
      case 'time':
        return (
          <div className="gova1-field" key={path}>
            <label htmlFor={id}>{head}</label>
            <input {...common} type="time" value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)} />
            {hintNode}
            {message}
          </div>
        );
      case 'text':
        return (
          <div className="gova1-field" key={path}>
            <label htmlFor={id}>{head}</label>
            {spec.max > 120 ? (
              <textarea {...common} rows={3} value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)} />
            ) : (
              <input {...common} type="text" autoComplete="off" value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.target.value)} />
            )}
            {hintNode}
            {message}
          </div>
        );
      case 'list': {
        const items = Array.isArray(value) ? value : [];
        const failing = byPath.get(path);
        return (
          <fieldset className="gova1-group" key={path} data-testid={`list-${path}`} disabled={disabled} aria-describedby={failing === undefined ? undefined : `${id}-error`}>
            <legend>{head}</legend>
            {hintNode}
            {failing === undefined ? null : (
              <span className="gova1-error" id={`${id}-error`} data-testid={`error-${path}`}>
                <span aria-hidden="true">⚠ </span>
                {problemText(t, failing)}
              </span>
            )}
            {items.map((item, index) => (
              <div className="gova1-item" key={`${path}[${index}]`} data-item={`${path}[${index}]`}>
                {renderField(name, spec.of, `${path}[${index}]`, [...trail, index], item, t('gova1.form.item', { name, index: index + 1 }))}
                <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`remove-${path}[${index}]`} onClick={() => set(items.filter((_, at) => at !== index))}>
                  {t('gova1.form.remove', { index: index + 1 })}
                </button>
              </div>
            ))}
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`add-${path}`} disabled={items.length >= spec.max} onClick={() => set([...items, blankDraft(spec.of)])}>
              {t('gova1.form.add')}
            </button>
          </fieldset>
        );
      }
      case 'object':
        return (
          <fieldset className="gova1-group" key={path} disabled={disabled}>
            <legend>{head}</legend>
            {Object.entries(spec.fields).map(([key, field]) => renderField(key, field, `${path}.${key}`, [...trail, key], isDraftRecord(value) ? value[key] : undefined, key))}
          </fieldset>
        );
    }
  };

  return (
    <div className="gova1-form" data-testid="params-form">
      {Object.entries(schema).map(([key, spec]) => renderField(key, spec, key, [key], isDraftRecord(draft) ? draft[key] : undefined, ruleType === ALERT_TYPE ? (alertFieldText(t, key) ?? key) : key))}
    </div>
  );
}

const isDraftRecord = (value: Draft | undefined): value is { [key: string]: Draft } => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- The move of a version, said before it is made ------------------------------------------------------------------------------------------------------------------

export interface Receipt {
  move: Move;
  version: number;
  code: string;
  time: string;
}

export interface MoveDialogProps {
  version: RuleVersion;
  move: Move;
  me: string | undefined;
  onClose: () => void;
  onDone: (receipt: Receipt) => void;
}

/**
 * The confirmation of submit, withdraw, approve and retire: it names the object, the version, the period and the reason of the version, says the maker, submitter and approver rule before the move and again when the
 * server refuses it (inside the dialog, never behind it), and asks for a reason of 5 to 500 characters. A retired approved version may be given the day it stops; the server judges that day.
 */
export function MoveDialog({ version, move, me, onClose, onDone }: MoveDialogProps) {
  const { t, locale } = useTranslation();
  const send = useRuleMove();
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const [endDay, setEndDay] = useState('');
  const approvedRetire = move === 'retire' && version.status === 'APPROVED';
  const context = [
    { label: t('gova1.dialog.object'), value: `${version.ruleType} · ${version.code}` },
    { label: t('gova1.dialog.version'), value: t('gova1.dialog.versionValue', { version: version.version, status: statusText(t, version.status) }) },
    { label: t('gova1.dialog.period'), value: periodText(t, version.effectiveFrom, version.effectiveTo) },
    { label: t('gova1.dialog.versionReason'), value: version.reason },
    { label: t('gova1.dialog.people'), value: t('gova1.dialog.peopleValue', { maker: personText(t, version.createdBy, me), submitter: personText(t, version.submittedBy, me) }) },
    { label: t('gova1.dialog.rule'), value: moveRule(t, move) },
  ];
  const confirm = (reason?: string): void => {
    setRefusal(undefined);
    send.mutate(
      { move, id: version.id, version: version.resourceVersion, reason: reason ?? '', ...(approvedRetire && endDay !== '' ? { effectiveTo: endDay } : {}) },
      {
        onSuccess: () => onDone({ move, version: version.version, code: version.code, time: momentText(new Date().toISOString(), locale) }),
        onError: (error) => setRefusal(describeRefusal(error)),
      },
    );
  };
  return (
    <ConfirmDialog
      open
      title={moveTitle(t, move, version.status, { version: version.version, code: version.code })}
      context={context}
      confirmLabel={moveText(t, move, version.status)}
      cancelLabel={t('gova1.common.cancel')}
      pending={send.isPending}
      reason={{ label: reasonLabel(t, move), required: true, minLength: REASON_MIN, hint: t('gova1.dialog.reason.hint', { min: REASON_MIN, max: REASON_MAX }) }}
      {...(refusal === undefined ? {} : { error: refusalText(t, refusal) })}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {approvedRetire ? (
        <div className="gova1-field">
          <label htmlFor="gova1-end-day">{t('gova1.dialog.endDay')}</label>
          <input id="gova1-end-day" type="date" value={endDay} disabled={send.isPending} onChange={(event) => setEndDay(event.target.value)} data-testid="end-day" />
        </div>
      ) : undefined}
    </ConfirmDialog>
  );
}

/** The text of a move that cannot be made, next to the button that would make it. */
export function BlockNote({ block }: { block: Parameters<typeof blockText>[1] }) {
  const { t } = useTranslation();
  return (
    <span className="gova1-block" role="note">
      <span aria-hidden="true">ⓘ </span>
      {blockText(t, block)}
    </span>
  );
}
