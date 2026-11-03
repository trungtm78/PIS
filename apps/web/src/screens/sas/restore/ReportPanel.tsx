import { useTranslation } from '../../../i18n';
import { toneClass } from '../tenants/labels';
import { mismatchLabel } from './labels';
import { clock } from './model';
import type { ReportView } from './model';

interface Props {
  report: ReportView;
  reference: string | undefined;
  restoredTo: string | undefined;
  day: (value: string) => string;
}

/**
 * The verification report of a restore (NFR-AVAILABILITY-03): what the restored copy holds against what the backup recorded, table by table (rows, checksum, money totals), whether any row of another tenant is in it, and the RPO and
 * the RTO measured against the targets. The reference is the sha256 of the report: the record of the drill.
 */
export function ReportPanel({ report, reference, restoredTo, day }: Props) {
  const { t, locale } = useTranslation();
  const count = (value: number): string => value.toLocaleString(locale);
  return (
    <div data-report data-matched={report.matched}>
      <h3>{t('sas.restore.report.title')}</h3>
      <p className={report.matched ? 'callout' : 'callout warning'} role={report.matched ? 'status' : 'alert'} data-verdict>
        {report.matched ? t('sas.restore.report.matched') : t('sas.restore.report.notMatched', { count: report.mismatches.length })}
      </p>
      <dl className="kv">
        <dt>{t('sas.restore.report.tables')}</dt>
        <dd data-tables>{count(report.tablesCount)}</dd>
        <dt>{t('sas.restore.report.rows')}</dt>
        <dd data-rows>{t('sas.restore.report.rowsOf', { restored: count(report.rowsRestored), expected: count(report.rowsExpected) })}</dd>
        <dt>{t('sas.restore.report.money')}</dt>
        <dd data-money>{t('sas.restore.report.moneyOf', { restored: report.moneyRestored, expected: report.moneyExpected })}</dd>
        <dt>{t('sas.restore.report.foreign')}</dt>
        <dd data-foreign>{report.foreignRows === 0 ? t('sas.restore.report.foreignNone') : t('sas.restore.report.foreignSome', { count: count(report.foreignRows) })}</dd>
        <dt>{t('sas.restore.report.restoredTo')}</dt>
        <dd>{restoredTo === undefined ? '—' : day(restoredTo)}</dd>
        <dt>{t('sas.restore.report.rpo')}</dt>
        <dd data-rpo>{t('sas.restore.report.against', { measured: clock(report.rpoSeconds), target: clock(report.rpoTargetSeconds) })}</dd>
        <dt>{t('sas.restore.report.rto')}</dt>
        <dd data-rto>{t('sas.restore.report.against', { measured: clock(report.rtoSeconds), target: clock(report.rtoTargetSeconds) })}</dd>
        <dt>{t('sas.restore.report.targets')}</dt>
        <dd data-targets>
          <span className={toneClass(report.withinTargets ? 'ok' : 'warn')}>{report.withinTargets ? t('sas.restore.report.within') : t('sas.restore.report.outside')}</span>
        </dd>
        <dt>{t('sas.restore.report.reference')}</dt>
        <dd data-reference>{reference === undefined ? '—' : <code>{reference}</code>}</dd>
      </dl>
      {report.mismatches.length === 0 ? null : (
        <ul data-mismatches>
          {report.mismatches.map((code) => (
            <li key={code}>{mismatchLabel(t, code)}</li>
          ))}
        </ul>
      )}
      <table className="table" data-report-tables>
        <thead>
          <tr>
            <th scope="col">{t('sas.restore.report.column.table')}</th>
            <th scope="col" className="amount">
              {t('sas.restore.report.column.rows')}
            </th>
            <th scope="col">{t('sas.restore.report.column.checksum')}</th>
            <th scope="col">{t('sas.restore.report.column.money')}</th>
          </tr>
        </thead>
        <tbody>
          {report.tables.map((table) => (
            <tr key={table.table} data-table={table.table}>
              <td>
                <code>{table.table}</code>
              </td>
              <td className="amount" data-rows-match={table.rowsMatch}>
                {t('sas.restore.report.rowsOf', { restored: count(table.restoredRows), expected: count(table.expectedRows) })}
                <span className={toneClass(table.rowsMatch ? 'ok' : 'red')}>{table.rowsMatch ? t('sas.restore.report.match') : t('sas.restore.report.differ')}</span>
              </td>
              <td data-checksum-match={table.checksumMatch}>
                <span className={toneClass(table.checksumMatch ? 'ok' : 'red')}>{table.checksumMatch ? t('sas.restore.report.match') : t('sas.restore.report.differ')}</span>
              </td>
              <td>
                {table.money.length === 0
                  ? '—'
                  : table.money.map((money) => (
                      <div key={money.column} data-money-column={money.column} data-match={money.match}>
                        <code>{money.column}</code> {t('sas.restore.report.moneyOf', { restored: money.restored === '' ? '—' : money.restored, expected: money.expected === '' ? '—' : money.expected })}{' '}
                        <span className={toneClass(money.match ? 'ok' : 'red')}>{money.match ? t('sas.restore.report.match') : t('sas.restore.report.differ')}</span>
                      </div>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
