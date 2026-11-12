import { useId, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ReportChoice } from './hooks';
import { reportStatusLabel, stepLabel } from './labels';
import type { ReportDetail } from './model';
import { digitsOf, formatVnd } from './money';
import { STEPS, stepLink } from './step-model';
import type { StepKey } from './step-model';

/**
 * An amount of dong typed as a person writes it. While it is typed it is left alone; when the field is left, an amount is written with a dot between the thousands and anything that is not an
 * amount is left as it was, for the form to refuse in words.
 */
export function MoneyInput({ id, value, disabled, invalid, onChange, label }: { id: string; value: string; disabled?: boolean; invalid?: boolean; onChange(value: string): void; label: string }) {
  const [focused, setFocused] = useState(false);
  const digits = digitsOf(value);
  const shown = !focused && digits !== undefined ? formatVnd(digits) : value;
  return (
    <input
      id={id}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={invalid === true ? `${id}-error` : undefined}
      inputMode="numeric"
      autoComplete="off"
      className="num"
      disabled={disabled === true}
      value={shown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

/** The steps of the draft in the order a person goes through them; the one that is open is marked, the others lead to the same report. */
export function StepNav({ reportId, current }: { reportId: string; current: StepKey }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('dis.reportSteps.nav.aria')} className="dis-steps">
      <ol>
        {STEPS.map((step) => (
          <li key={step.key}>
            <Link to={stepLink(step.path, reportId)} aria-current={step.key === current ? 'step' : undefined}>
              {stepLabel(t, step.key)}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** What the report is about: the project, the period, the plan version, the status and the revision. */
export function ReportFacts({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  return (
    <dl className="aud-facts" data-testid="report-facts">
      <dt>{t('dis.reportEdit.project.label')}</dt>
      <dd data-testid="fact-project">{`${detail.project.code} · ${detail.project.name}`}</dd>
      <dt>{t('dis.reportEdit.period.label')}</dt>
      <dd data-testid="fact-period">{t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate })}</dd>
      <dt>{t('dis.reportEdit.plan.label')}</dt>
      <dd data-testid="fact-plan">{t('dis.reportEdit.plan.value', { year: detail.planVersion.fiscalYear, revision: detail.planVersion.revision })}</dd>
      <dt>{t('dis.reportEdit.status.label')}</dt>
      <dd>
        <span className="pill gray" data-testid="fact-status">
          {reportStatusLabel(t, detail.status)}
        </span>{' '}
        {t('dis.reportEdit.revision.value', { revision: detail.revision })}
      </dd>
    </dl>
  );
}

/** The note and the selector of a screen of one report that was opened without one: it says which report is shown and lets the reader switch to another of the list. */
export function DefaultReportBar({ choice }: { choice: ReportChoice }) {
  const { t } = useTranslation();
  const selectId = useId();
  if (!choice.defaulted || choice.reportId === undefined || choice.choices.length === 0) return null;
  return (
    <div className="callout" role="status" data-testid="default-report">
      <p>{t('dis.default.notice')}</p>
      <label htmlFor={selectId}>{t('dis.default.select.label')} </label>
      <select id={selectId} data-testid="default-report-select" value={choice.reportId} onChange={(event) => choice.pick(event.target.value)}>
        {choice.choices.map((report) => (
          <option key={report.id} value={report.id}>
            {t('dis.default.option', { project: report.project.code, period: report.period.code, revision: report.revision, status: reportStatusLabel(t, report.status) })}
          </option>
        ))}
      </select>
    </div>
  );
}
