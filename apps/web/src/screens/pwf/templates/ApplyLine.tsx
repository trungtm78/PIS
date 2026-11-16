import { useTranslation } from '../../../i18n';
import { codeKey, factName } from '../codes';
import { FUNDING_SOURCES, PROJECT_GROUPS } from '../process/model';
import { alreadyApplies, linesFor, overlapping } from './assignment-model';
import type { ApplyChange, ApplyField, ApplyLine as Line } from './assignment-model';

export interface ApplyLineProps {
  /** The code of the template; empty for a template that is not saved yet (its lines are all waiting to be submitted). */
  templateCode: string;
  /** The params of the mapping rule in force. */
  rule: unknown;
  change: ApplyChange;
  onChange: (change: ApplyChange) => void;
  disabled: boolean;
  /** The kinds of project of the catalogue, by code. */
  typeNames: ReadonlyMap<string, string>;
}

/**
 * "Áp cho" (R60): which kinds of project take this procedure when they are registered. The chips are the lines of the mapping rule in force that point at the template; what a person adds or takes off here is not written
 * to the rule: it waits, said as such, and is submitted as a draft of the rule together with the template, where a different person approves both.
 */
export function ApplyLineBar({ templateCode, rule, change, onChange, disabled, typeNames }: ApplyLineProps) {
  const { t } = useTranslation();
  const lines = templateCode === '' ? [] : linesFor(rule, templateCode).filter((line) => !change.removed.includes(line.code));
  const valueText = (field: ApplyField, value: string): string => (field === 'project_type' ? (typeNames.get(value) ?? value) : factName(t, value));
  const lineText = (line: Line): string => line.when.map((entry) => `${t(`pwfx.apply.field.${codeKey(entry.field)}`)}: ${entry.in.map((value) => valueText(entry.field, value)).join(', ')}`).join(' · ');
  const options: Record<ApplyField, readonly string[]> = { project_type: [...typeNames.keys()], project_group: PROJECT_GROUPS, funding_source: FUNDING_SOURCES };
  const add = (field: ApplyField, value: string): void => {
    if (value === '' || alreadyApplies(rule, templateCode, change, field, value)) return;
    onChange({ ...change, added: [...change.added, { field, value, first: false }] });
  };
  return (
    <div className="pwfx-apply" data-testid="apply-line">
      <span className="pwfx-apply__label" id="pwfx-apply-label">
        {t('pwfx.apply.label')}
      </span>
      <ul className="pwfx-apply__chips" aria-labelledby="pwfx-apply-label">
        {lines.map((line) => (
          <li key={line.code} className="pwfx-chip" data-line={line.code}>
            <span>{lineText(line)}</span>
            {disabled ? null : (
              <button type="button" className="pwfx-chip__x" aria-label={t('pwfx.apply.remove', { text: lineText(line) })} onClick={() => onChange({ ...change, removed: [...change.removed, line.code] })}>
                <span aria-hidden="true">×</span>
              </button>
            )}
          </li>
        ))}
        {change.added.map((one, index) => {
          const rivals = overlapping(rule, templateCode, one.field, one.value);
          return (
            <li key={`${one.field}:${one.value}`} className="pwfx-chip pwfx-chip--waiting" data-pending="true">
              <span>
                {t(`pwfx.apply.field.${codeKey(one.field)}`)}: {valueText(one.field, one.value)} · {t('pwfx.apply.waiting')}
              </span>
              {rivals.length === 0 ? null : (
                <label className="pwfx-check" title={t('pwfx.apply.overlap', { codes: rivals.map((line) => line.templateCode).join(', ') })}>
                  <input type="checkbox" checked={one.first} disabled={disabled} onChange={(event) => onChange({ ...change, added: change.added.map((other, at) => (at === index ? { ...other, first: event.target.checked } : other)) })} /> {t('pwfx.apply.first', { codes: rivals.map((line) => line.templateCode).join(', ') })}
                </label>
              )}
              {disabled ? null : (
                <button type="button" className="pwfx-chip__x" aria-label={t('pwfx.apply.cancel', { text: valueText(one.field, one.value) })} onClick={() => onChange({ ...change, added: change.added.filter((_, at) => at !== index) })}>
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </li>
          );
        })}
        {change.removed.map((code) => {
          const line = linesFor(rule, templateCode).find((one) => one.code === code);
          return line === undefined ? null : (
            <li key={`gone-${code}`} className="pwfx-chip pwfx-chip--gone" data-removed="true">
              <span>
                <s>{lineText(line)}</s> · {t('pwfx.apply.removed')}
              </span>
              {disabled ? null : (
                <button type="button" className="pwfx-chip__x" aria-label={t('pwfx.apply.keep', { text: lineText(line) })} onClick={() => onChange({ ...change, removed: change.removed.filter((one) => one !== code) })}>
                  <span aria-hidden="true">↺</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {disabled ? null : (
        <span className="pwfx-apply__add">
          {(['project_type', 'project_group', 'funding_source'] as const).map((field) => (
            <select key={field} aria-label={t(`pwfx.apply.add.${codeKey(field)}`)} value="" onChange={(event) => add(field, event.target.value)}>
              <option value="">+ {t(`pwfx.apply.add.${codeKey(field)}`)}</option>
              {options[field].map((value) => (
                <option key={value} value={value}>
                  {valueText(field, value)}
                </option>
              ))}
            </select>
          ))}
        </span>
      )}
      <span className="pwf-hint">{t('pwfx.apply.hint')}</span>
    </div>
  );
}
