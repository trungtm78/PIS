import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { composeLink, reviewLink, vietnamToday } from '../diary/model';
import '../qms.css';
import { useCoverage } from './hooks';
import { describeCoverage, isMonth, isUuid, monthGrid } from './model';
import type { Cell, CoverageProblem, DayView } from './model';

type T = Translator['t'];

function problemMessage(t: T, problem: CoverageProblem): string {
  switch (problem) {
    case 'notFound':
      return t('qms.coverage.problem.notFound');
    case 'noCalendar':
      return t('qms.coverage.problem.noCalendar');
    case 'validation':
      return t('qms.coverage.problem.validation');
    case 'general':
      return t('qms.coverage.problem.general');
  }
}

function stateText(t: T, day: DayView): string {
  switch (day.state) {
    case 'SIGNED':
      return t('qms.coverage.state.signed');
    case 'DRAFT':
      return t('qms.coverage.state.draft');
    case 'MISSING':
      return t('qms.coverage.state.missing');
  }
}

const weekdays = (t: T): string[] => [t('qms.coverage.weekday.mon'), t('qms.coverage.weekday.tue'), t('qms.coverage.weekday.wed'), t('qms.coverage.weekday.thu'), t('qms.coverage.weekday.fri'), t('qms.coverage.weekday.sat'), t('qms.coverage.weekday.sun')];

/**
 * QMS-11: the coverage of the site diary of a contract by working day (ST-QMS-008, QMS 3.1, BR-QMS-08, UAT-AC364). A month as a calendar: every working day up to today says in words whether it has a signed diary, a draft or
 * none, whether a copy of a device waits to be settled, and for a diary signed late how many working days late; the days off and the days to come are left blank. The figures above are the server's, and the days that are
 * missing are listed.
 */
export default function CoverageScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: nothing of the one is left for the other.
  return <CoverageContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CoverageContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const contracts = useContracts();
  const [params] = useSearchParams();
  const [contractId, setContractId] = useState(() => params.get('contract') ?? '');
  const [month, setMonth] = useState(() => vietnamToday().slice(0, 7));
  const options = contracts.data ?? [];
  // The register of contracts and the diaries have scopes of their own: the list is a help, and a contract that is not in it is named by its identifier.
  const listed = contracts.isPending || options.length > 0;
  const valid = isMonth(month);
  const named = contractId.trim().toLowerCase();
  const known = named === '' || isUuid(named);
  const coverage = useCoverage(valid && known ? named : '', month);
  const chosen = named !== '' && known && valid;
  const state = useScreenState({ isLoading: coverage.isLoading, error: coverage.error, data: coverage.data === null ? undefined : coverage.data, isEmpty: () => false });
  const figures = coverage.data?.totals;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('qms.coverage.title')}</h1>
          <p>{t('qms.coverage.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        {listed ? (
          <div className="field">
            <label htmlFor="coverage-contract">{t('qms.coverage.field.contract')}</label>
            <select id="coverage-contract" value={options.some((contract) => contract.id === contractId) ? contractId : ''} onChange={(event) => setContractId(event.target.value)}>
              <option value="">{t('qms.coverage.field.contract.none')}</option>
              {options.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="coverage-contract-id">{t('qms.coverage.field.contractId')}</label>
          <input id="coverage-contract-id" type="text" value={contractId} onChange={(event) => setContractId(event.target.value)} />
          <small className="sub">{t('qms.coverage.field.contract.hint')}</small>
          {known ? null : (
            <small role="alert" className="field-error">
              {t('qms.coverage.field.contract.error')}
            </small>
          )}
        </div>
        <div className="field">
          <label htmlFor="coverage-month">{t('qms.coverage.field.month')}</label>
          <input id="coverage-month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          {valid ? null : (
            <small role="alert" className="field-error">
              {t('qms.coverage.field.month.error')}
            </small>
          )}
        </div>
      </div>
      {coverage.isError && describeCoverage(coverage.error) !== 'general' ? (
        <p className="callout warning" role="alert" data-testid="coverage-refusal">
          {problemMessage(t, describeCoverage(coverage.error))}
        </p>
      ) : !chosen ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('qms.coverage.noContract.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void coverage.refetch()}>
          {coverage.data == null || figures === undefined ? null : (
            <>
              <dl className="card" data-testid="totals">
                {(
                  [
                    ['workingDays', t('qms.coverage.total.workingDays')],
                    ['withDiary', t('qms.coverage.total.withDiary')],
                    ['signed', t('qms.coverage.total.signed')],
                    ['draft', t('qms.coverage.total.draft')],
                    ['missing', t('qms.coverage.total.missing')],
                    ['late', t('qms.coverage.total.late')],
                    ['conflict', t('qms.coverage.total.conflict')],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} data-figure={key}>
                    <dt>{label}</dt>
                    <dd>{figures[key]}</dd>
                  </div>
                ))}
              </dl>
              {coverage.data.through === null ? (
                <p className="callout" role="status" data-testid="not-yet">
                  {t('qms.coverage.notYet.notice')}
                </p>
              ) : null}
              <table className="table" aria-label={t('qms.coverage.calendar.aria', { contract: coverage.data.contractCode, month })} data-testid="calendar">
                <thead>
                  <tr>
                    {weekdays(t).map((name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthGrid(month, coverage.data.days).map((week) => (
                    <tr key={week.find((cell) => cell !== null)?.date ?? 'empty'}>
                      {week.map((cell, index) => (
                        <DayCell key={cell?.date ?? `blank-${index}`} cell={cell} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {coverage.data.missingDates.length === 0 ? null : (
                <section aria-labelledby="missing-title" data-testid="missing">
                  <h2 id="missing-title">{t('qms.coverage.missing.title')}</h2>
                  <ul>
                    {coverage.data.missingDates.map((date) => (
                      <li key={date}>{date}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('qms.coverage.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DayCell({ cell }: { cell: Cell | null }) {
  const { t } = useTranslation();
  if (cell === null) return <td aria-hidden="true" />;
  const number = Number(cell.date.slice(8, 10));
  const day = cell.day;
  if (day === undefined) return <td data-date={cell.date}>{number}</td>;
  const link = day.diaryId === null ? undefined : day.state === 'DRAFT' ? composeLink(day.diaryId) : reviewLink(day.diaryId);
  const label = stateText(t, day);
  return (
    <td data-date={cell.date} data-state={day.state} data-late={day.lateDays} data-conflict={day.conflict}>
      <strong>{number}</strong>
      <span className={`pill ${day.state === 'SIGNED' ? 'green' : day.state === 'DRAFT' ? 'warn' : 'red'}`}>{link === undefined ? label : <Link to={link}>{label}</Link>}</span>
      {day.lateDays > 0 ? <span className="sub">{t('qms.coverage.day.late', { days: day.lateDays })}</span> : null}
      {day.conflict ? <span className="sub">{t('qms.coverage.day.conflict')}</span> : null}
    </td>
  );
}
