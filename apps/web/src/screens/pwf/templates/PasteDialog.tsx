import { useMemo, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import type { Choice } from './editor-choices';
import { appendPasted, parsePaste } from './quick-start';
import type { PasteProblem } from './quick-start';
import { MAX_TASKS } from './template-model';
import type { Template } from './template-model';

export interface PasteDialogProps {
  template: Template;
  /** The phase the rows go to when the template has several. */
  phases: readonly { code: string; name: string }[];
  /** The units a pasted name can match (by the name people read). */
  units: readonly Choice[];
  onAdd: (next: Template, added: number) => void;
  onClose: () => void;
}

/**
 * Rows copied from a spreadsheet (R70): the name of the step, the unit and the number of days, one row to a line, the cells apart by tabs. The text is read into a preview that says what is wrong with each row; only the
 * rows without a problem are added and only at the end of the phase: nothing already in the table is changed or replaced. A unit is set only when its name is one of the choices.
 */
export function PasteDialog({ template, phases, units, onAdd, onClose }: PasteDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [phase, setPhase] = useState(phases[phases.length - 1]?.code ?? '');
  const rows = useMemo(() => parsePaste(text), [text]);
  const unitRefOf = (name: string): string | undefined => units.find((unit) => unit.label.trim().toLowerCase() === name.trim().toLowerCase())?.value;
  const good = rows.filter((row) => row.problems.length === 0);
  const room = Math.max(0, MAX_TASKS - template.tasks.length);
  const word = (problem: PasteProblem): string => t(`pwfx.paste.problem.${problem}`);
  return (
    <ConfirmDialog
      open
      title={t('pwfx.paste.title')}
      context={[]}
      confirmLabel={t('pwfx.paste.confirm', { count: Math.min(good.length, room) })}
      cancelLabel={t('pwfx.paste.cancel')}
      confirmDisabled={good.length === 0 || phase === ''}
      onCancel={onClose}
      onConfirm={() => {
        const outcome = appendPasted(template, phase, good, unitRefOf);
        onAdd(outcome.template, outcome.added);
      }}
    >
      <p className="pwf-hint">{t('pwfx.paste.hint')}</p>
      <label htmlFor="pwfx-paste-text">{t('pwfx.paste.text')}</label>
      <textarea id="pwfx-paste-text" rows={5} value={text} data-testid="paste-text" onChange={(event) => setText(event.target.value)} />
      {phases.length < 2 ? null : (
        <>
          <label htmlFor="pwfx-paste-phase">{t('pwfx.paste.phase')}</label>
          <select id="pwfx-paste-phase" value={phase} onChange={(event) => setPhase(event.target.value)}>
            {phases.map((one) => (
              <option key={one.code} value={one.code}>
                {one.name.trim() === '' ? one.code : one.name}
              </option>
            ))}
          </select>
        </>
      )}
      {rows.length === 0 ? null : (
        <table className="ui-table pwfx-paste" data-testid="paste-preview">
          <caption>{t('pwfx.paste.preview', { good: good.length, all: rows.length })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('pwfx.paste.col.line')}</th>
              <th scope="col">{t('pwfx.col.step')}</th>
              <th scope="col">{t('pwfx.col.unit')}</th>
              <th scope="col">{t('pwfx.paste.col.days')}</th>
              <th scope="col">{t('pwfx.paste.col.state')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line} data-ok={row.problems.length === 0}>
                <td>{row.line}</td>
                <td>{row.name}</td>
                <td>{row.unit === '' ? '–' : unitRefOf(row.unit) === undefined ? `${row.unit} (${t('pwfx.paste.unit.unknown')})` : row.unit}</td>
                <td>{row.days ?? '–'}</td>
                <td>{row.problems.length === 0 ? t('pwfx.paste.ok') : row.problems.map(word).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {good.length > room ? <p className="pwfx-cell-error">{t('pwfx.paste.full', { count: good.length - room })}</p> : null}
    </ConfirmDialog>
  );
}
