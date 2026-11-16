import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { MAX_YEAR, MIN_YEAR, countWorkingDays, rulesOfCalendar } from './model';
import { isYearInRange, openingVersion } from './year-model';
import type { YearRow } from './year-model';

interface YearListProps {
  rows: readonly YearRow[];
  opened: { code: string; year: number } | undefined;
  /** Only the code of a calendar that is not the default one is named in the list. */
  defaultCode: string;
  canManage: boolean;
  onOpen: (code: string, year: number) => void;
}

/** ADM-07: the years of the working calendar with the state of each (draft, confirmed), and the way to start another year. */
export function YearList({ rows, opened, defaultCode, canManage, onOpen }: YearListProps) {
  const { t } = useTranslation();
  const id = useId();
  const [other, setOther] = useState('');
  const [problem, setProblem] = useState(false);

  const start = (event: FormEvent): void => {
    event.preventDefault();
    const year = Number(other);
    if (!isYearInRange(year)) {
      setProblem(true);
      return;
    }
    setProblem(false);
    onOpen(defaultCode, year);
    setOther('');
  };

  return (
    <SectionCard title={t('wfxcal.years.title')}>
      <div data-testid="years">
        <KitTable caption={t('wfxcal.years.caption')}>
          <thead>
            <tr>
              <th>{t('adm.calendar.col.year')}</th>
              <th>{t('adm.calendar.col.status')}</th>
              <th className="cal-num">{t('wfxcal.years.col.days')}</th>
              <th>
                <span className="ui-sr-only">{t('adm.calendar.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const shown = openingVersion(row);
              const isOpen = opened?.year === row.year && opened.code === row.code;
              return (
                <tr key={`${row.code}:${row.year}`} data-year={row.year} data-code={row.code} aria-current={isOpen ? 'true' : undefined}>
                  <td>
                    <strong>{row.year}</strong>
                    {row.code === defaultCode ? null : <span className="cal-code"> {row.code}</span>}
                  </td>
                  <td>
                    <span className="cal-chips">
                      {row.confirmed === undefined ? null : <StatusPill tone="success" icon="✔">{t('wfxcal.state.confirmedRev.label', { revision: row.confirmed.revision })}</StatusPill>}
                      {row.draft === undefined ? null : <StatusPill tone="warning" icon="✎">{t('wfxcal.state.draftRev.label', { revision: row.draft.revision })}</StatusPill>}
                      {row.confirmed === undefined && row.draft === undefined ? <StatusPill tone="neutral">{t('wfxcal.state.none.label')}</StatusPill> : null}
                    </span>
                  </td>
                  <td className="cal-num">{shown === undefined ? '–' : countWorkingDays(rulesOfCalendar(shown), row.year)}</td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('wfxcal.years.open.label', { year: row.year })} aria-pressed={isOpen} onClick={() => onOpen(row.code, row.year)}>
                      {shown === undefined && canManage ? t('wfxcal.years.create.action') : t('wfxcal.years.open.action')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </KitTable>
        {canManage ? (
          <form className="cal-other" onSubmit={start} noValidate aria-label={t('wfxcal.years.other.title')}>
            <div className="field">
              <label htmlFor={`${id}-other`}>{t('wfxcal.years.other.label')}</label>
              <input id={`${id}-other`} inputMode="numeric" value={other} aria-invalid={problem} onChange={(event) => { setOther(event.target.value); setProblem(false); }} />
              {problem ? (
                <small role="alert" className="field-error">
                  {t('adm.calendar.field.range', { min: MIN_YEAR, max: MAX_YEAR })}
                </small>
              ) : null}
            </div>
            <button type="submit" className="ui-button ui-button--outline">
              {t('wfxcal.years.other.action')}
            </button>
          </form>
        ) : null}
      </div>
    </SectionCard>
  );
}
