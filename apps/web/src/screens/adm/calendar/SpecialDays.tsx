import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { specialMessage } from './labels';
import type { CalendarValues } from './model';
import { addSpecial, groupByMonth, removeEntry, setEntryText, specialEntries, specialProblem } from './year-model';
import type { SpecialEntry, SpecialKind, SpecialProblem } from './year-model';

interface SpecialDaysProps {
  values: CalendarValues;
  year: number;
  /** False for a reader and in a suspended tenant: the table is shown, nothing can be added, changed or removed. */
  editable: boolean;
  /** The name of a holiday is empty or a compensated day clashes: the message the form found at save time. */
  problem: string | undefined;
  onChange: (next: CalendarValues) => void;
}

/** One date as the person reads it, in the language of the screen; a run of days reads "from – to". */
function useDayFormat() {
  const { locale } = useTranslation();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    const month = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    const at = (date: string): Date => new Date(`${date}T00:00:00Z`);
    return {
      range: (entry: SpecialEntry): string => (entry.from === entry.to ? day.format(at(entry.from)) : `${day.format(at(entry.from))} – ${day.format(at(entry.to))}`),
      month: (number: number): string => month.format(new Date(Date.UTC(2000, number - 1, 1))),
    };
  }, [locale]);
}

/**
 * ADM-07: "Thêm ngày" (a day or a run of days, a day off or a working day made up, with a note) and the table of the special days of the year grouped by month. A holiday's note and basis are edited in the table; a day is taken
 * out with "Bỏ". The server keeps a holiday as a dated name and a made-up working day as a date, so a made-up day has no note.
 */
export function SpecialDays({ values, year, editable, problem, onChange }: SpecialDaysProps) {
  const { t } = useTranslation();
  const ids = useId();
  const format = useDayFormat();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<SpecialKind>('off');
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('');
  const [refused, setRefused] = useState<SpecialProblem | undefined>(undefined);
  const [done, setDone] = useState<{ added: number; skipped: number } | undefined>(undefined);
  const groups = useMemo(() => groupByMonth(specialEntries(values)), [values]);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!editable) return;
    const input = { kind, from, to, name, basis };
    const found = specialProblem(year, input);
    setRefused(found);
    setDone(undefined);
    if (found !== undefined) return;
    const result = addSpecial(values, input);
    onChange(result.values);
    setDone({ added: result.added, skipped: result.skippedHoliday + result.skippedWorking });
    setFrom('');
    setTo('');
    setName('');
    setBasis('');
  };

  return (
    <>
      <form className="cal-add" onSubmit={submit} noValidate aria-label={t('wfxcal.add.title')}>
        <fieldset disabled={!editable}>
          <legend>{t('wfxcal.add.title')}</legend>
          <div className="cal-add__row">
            <div className="field">
              <label htmlFor={`${ids}-from`}>{t('wfxcal.add.from.label')}</label>
              <input id={`${ids}-from`} type="date" min={yearStart} max={yearEnd} value={from} aria-invalid={refused === 'dateRequired' || refused === 'dateInvalid' || refused === 'outOfYear'} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-to`}>{t('wfxcal.add.to.label')}</label>
              <input id={`${ids}-to`} type="date" min={yearStart} max={yearEnd} value={to} aria-describedby={`${ids}-to-hint`} onChange={(event) => setTo(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-kind`}>{t('wfxcal.add.kind.label')}</label>
              <select id={`${ids}-kind`} value={kind} onChange={(event) => setKind(event.target.value as SpecialKind)}>
                <option value="off">{t('wfxcal.kind.off.label')}</option>
                <option value="work">{t('wfxcal.kind.work.label')}</option>
              </select>
            </div>
          </div>
          <small className="sub" id={`${ids}-to-hint`}>
            {t('wfxcal.add.to.hint')}
          </small>
          {kind === 'off' ? (
            <div className="cal-add__row">
              <div className="field cal-add__grow">
                <label htmlFor={`${ids}-name`}>{t('wfxcal.add.note.label')}</label>
                <input id={`${ids}-name`} value={name} aria-invalid={refused === 'nameRequired'} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="field cal-add__grow">
                <label htmlFor={`${ids}-basis`}>{t('wfxcal.add.basis.label')}</label>
                <input id={`${ids}-basis`} value={basis} onChange={(event) => setBasis(event.target.value)} />
              </div>
            </div>
          ) : (
            <small className="sub">{t('wfxcal.add.work.hint')}</small>
          )}
          {refused === undefined ? null : (
            <small role="alert" className="field-error" data-testid="add-problem">
              {specialMessage(t, refused)}
            </small>
          )}
          {done === undefined ? null : (
            <small role="status" className="sub" data-testid="add-done">
              {done.skipped === 0 ? t('wfxcal.add.done.status', { count: done.added }) : t('wfxcal.add.doneSkipped.status', { count: done.added, skipped: done.skipped })}
            </small>
          )}
          <div className="adm-kit-actions">
            <button type="submit" className="ui-button ui-button--outline">
              {t('wfxcal.add.action')}
            </button>
          </div>
        </fieldset>
      </form>
      <div className="cal-special" data-testid="special-days">
        <h3>{t('wfxcal.special.title')}</h3>
        {problem === undefined ? null : (
          <small role="alert" className="field-error">
            {problem}
          </small>
        )}
        {groups.length === 0 ? (
          <p className="muted">{t('wfxcal.special.empty')}</p>
        ) : (
          <KitTable caption={t('wfxcal.special.caption')} testId="special-table">
            <thead>
              <tr>
                <th>{t('wfxcal.special.col.day')}</th>
                <th>{t('wfxcal.special.col.kind')}</th>
                <th>{t('wfxcal.special.col.note')}</th>
                <th>{t('wfxcal.special.col.basis')}</th>
                <th>
                  <span className="ui-sr-only">{t('wfxcal.special.col.actions')}</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.month} data-month={group.month}>
                <tr className="cal-group">
                  <th scope="rowgroup" colSpan={5}>
                    {format.month(group.month)}
                  </th>
                </tr>
                {group.entries.map((entry) => {
                  const label = format.range(entry);
                  return (
                    <tr key={entry.id} data-special={entry.id} data-kind={entry.kind}>
                      <td className="cal-nowrap">{label}</td>
                      <td>
                        <StatusPill tone={entry.kind === 'off' ? 'danger' : 'success'}>{entry.kind === 'off' ? t('wfxcal.kind.off.label') : t('wfxcal.kind.work.label')}</StatusPill>
                      </td>
                      <td>
                        {entry.kind === 'work' ? (
                          <span className="muted">–</span>
                        ) : (
                          <>
                            <label className="sr-only" htmlFor={`${ids}-n-${entry.id}`}>
                              {t('wfxcal.special.note.label', { day: label })}
                            </label>
                            <input id={`${ids}-n-${entry.id}`} value={entry.name} disabled={!editable} onChange={(event) => onChange(setEntryText(values, entry, 'name', event.target.value))} />
                          </>
                        )}
                      </td>
                      <td>
                        {entry.kind === 'work' ? (
                          <span className="muted">–</span>
                        ) : (
                          <>
                            <label className="sr-only" htmlFor={`${ids}-b-${entry.id}`}>
                              {t('wfxcal.special.basis.label', { day: label })}
                            </label>
                            <input id={`${ids}-b-${entry.id}`} value={entry.basis} disabled={!editable} onChange={(event) => onChange(setEntryText(values, entry, 'basis', event.target.value))} />
                          </>
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('wfxcal.special.remove.label', { day: label })} onClick={() => onChange(removeEntry(values, entry))}>
                            {t('wfxcal.special.remove.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </KitTable>
        )}
      </div>
    </>
  );
}
