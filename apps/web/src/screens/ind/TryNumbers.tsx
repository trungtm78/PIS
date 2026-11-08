import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { SectionCard, StatusPill } from '../../ui';
import { ProblemNote, ViolationList } from './ind-components';
import { useEvaluate } from './ind-hooks';
import { periodStatusLabel, skipLabel, surfaceLabel } from './ind-labels';
import { PERIOD_STATUSES, SURFACES, describeProblem, factFault, factsOf, holds, periodStatusOf, surfaceOf } from './ind-model';
import type { FactLine, PeriodStatus, Problem, Surface, Verdict } from './ind-model';
import './ind.css';

const blank = (): FactLine => ({ field: '', value: '' });

/**
 * "Try numbers" (IND-02): the numbers of an entry are held up to the rules of a surface and the verdict is shown, writing nothing. The person names the surface, the state of the period and the fields with their
 * numbers (the field names are those the rules name: CUMULATIVE, TOTAL_INVESTMENT, EQUITY, DEBT, TOTAL, PHYSICAL_PROGRESS...). The starting rules are held to only when the person asks, to see what adopting them would do.
 */
export function TryNumbers({ surfaces }: { surfaces: readonly Surface[] }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const ids = useId();
  const evaluate = useEvaluate();
  const offered = surfaces.length === 0 ? SURFACES : surfaces;
  const [surface, setSurface] = useState<Surface>('DIS_REPORT');
  const [periodStatus, setPeriodStatus] = useState<PeriodStatus | ''>('');
  const [templates, setTemplates] = useState(false);
  const [lines, setLines] = useState<FactLine[]>([blank()]);
  const [verdict, setVerdict] = useState<Verdict | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const mayTry = mode !== 'READ_ONLY' && holds(permissions, 'ind.entry');
  const facts = factsOf(lines);
  const ready = Object.keys(facts).length > 0 && lines.every((line) => (line.field === '' && line.value === '') || factFault(line, lines) === undefined);

  const touch = (next: FactLine[]): void => {
    setLines(next);
    setVerdict(undefined);
    setProblem(undefined);
  };
  const run = (): void => {
    if (!ready || evaluate.isPending) return;
    setProblem(undefined);
    evaluate.mutate(
      { surface, values: facts, periodStatus, includeTemplates: templates },
      {
        onSuccess: (result) => (result === undefined ? setProblem({ kind: 'general', code: '', detail: '', missing: [], violations: [] }) : setVerdict(result)),
        onError: (error) => setProblem(describeProblem(error)),
      },
    );
  };

  return (
    <SectionCard title={t('ind.rules.try.title')}>
      <p className="sub">{t('ind.rules.try.note')}</p>
      {mode === 'READ_ONLY' ? (
        <p className="callout" role="status" data-testid="try-readonly">
          {t('ind.rules.try.readOnly')}
        </p>
      ) : !mayTry ? (
        <p className="callout" role="status" data-testid="try-noauthority">
          {t('ind.rules.try.noAuthority')}
        </p>
      ) : (
        <form
          className="ind-form"
          aria-label={t('ind.rules.try.title')}
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <div className="field">
            <label htmlFor={`${ids}-surface`}>{t('ind.rules.try.surface')}</label>
            <select id={`${ids}-surface`} value={surface} onChange={(event) => { setSurface(surfaceOf(event.target.value) ?? 'DIS_REPORT'); setVerdict(undefined); }}>
              {offered.map((one) => (
                <option key={one} value={one}>
                  {surfaceLabel(t, one)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-period`}>{t('ind.rules.try.period')}</label>
            <select id={`${ids}-period`} value={periodStatus} onChange={(event) => { setPeriodStatus(periodStatusOf(event.target.value) ?? ''); setVerdict(undefined); }}>
              <option value="">{t('ind.rules.try.periodNone')}</option>
              {PERIOD_STATUSES.map((one) => (
                <option key={one} value={one}>
                  {periodStatusLabel(t, one)}
                </option>
              ))}
            </select>
          </div>
          {lines.map((line, index) => {
            const key = `${ids}-fact-${index}`;
            const fault = line.field === '' && line.value === '' ? undefined : factFault(line, lines);
            return (
              <fieldset className="ind-line" key={key} data-testid="fact-line" data-fault={fault}>
                <legend>{t('ind.rules.try.line', { n: index + 1 })}</legend>
                <div className="field">
                  <label htmlFor={`${key}-field`}>{t('ind.rules.try.field')}</label>
                  <input id={`${key}-field`} type="text" value={line.field} aria-invalid={fault === 'field' || fault === 'duplicate'} onChange={(event) => touch(lines.map((one, at) => (at === index ? { ...one, field: event.target.value.toUpperCase() } : one)))} />
                </div>
                <div className="field">
                  <label htmlFor={`${key}-value`}>{t('ind.rules.try.value')}</label>
                  <input id={`${key}-value`} type="text" inputMode="decimal" value={line.value} aria-invalid={fault === 'value'} onChange={(event) => touch(lines.map((one, at) => (at === index ? { ...one, value: event.target.value } : one)))} />
                </div>
                {fault === undefined ? null : (
                  <small className="sub" role="alert">
                    {fault === 'field' ? t('ind.rules.try.fault.field') : fault === 'duplicate' ? t('ind.rules.try.fault.duplicate') : t('ind.rules.try.fault.value')}
                  </small>
                )}
                {lines.length > 1 ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => touch(lines.filter((_, at) => at !== index))}>
                    {t('ind.rules.try.remove')}
                  </button>
                ) : null}
              </fieldset>
            );
          })}
          <div className="field ind-check">
            <input id={`${ids}-templates`} type="checkbox" checked={templates} onChange={(event) => { setTemplates(event.target.checked); setVerdict(undefined); }} />
            <label htmlFor={`${ids}-templates`}>{t('ind.rules.try.templates')}</label>
          </div>
          <div className="ind-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={lines.length >= 60} onClick={() => touch([...lines, blank()])}>
              {t('ind.rules.try.add')}
            </button>
            <button type="submit" className="ui-button ui-button--primary" disabled={!ready || evaluate.isPending}>
              {evaluate.isPending ? t('ind.rules.try.pending') : t('ind.rules.try.action')}
            </button>
          </div>
        </form>
      )}
      {problem === undefined ? null : <ProblemNote problem={problem} />}
      {verdict === undefined ? null : (
        <div role="status" data-testid="try-verdict" data-allowed={verdict.allowed ? 'true' : 'false'}>
          <p>
            <StatusPill tone={verdict.allowed ? 'success' : 'danger'} icon={verdict.allowed ? '✓' : '✕'}>
              {verdict.allowed ? t('ind.rules.try.allowed') : t('ind.rules.try.blocked')}
            </StatusPill>
          </p>
          {verdict.violations.length === 0 ? <p className="sub">{t('ind.rules.try.noViolations')}</p> : <ViolationList violations={verdict.violations} testId="try-violations" />}
          <p className="sub" data-testid="try-evaluated">
            {verdict.evaluated.length === 0 ? t('ind.rules.try.evaluatedNone') : t('ind.rules.try.evaluated', { codes: verdict.evaluated.join(', ') })}
          </p>
          {verdict.skipped.length === 0 ? null : (
            <ul className="sub" data-testid="try-skipped">
              {verdict.skipped.map((one) => (
                <li key={one.ruleCode} data-rule={one.ruleCode}>
                  {one.ruleCode}: {skipLabel(t, one.reason)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  );
}
