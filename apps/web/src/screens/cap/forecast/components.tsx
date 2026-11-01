import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field, Money } from '../components';
import type { ProjectOption } from '../plan-model';
import { MAX_YEAR, MIN_YEAR, yearOf } from '../schedule-model';
import { useProjectEstimate } from './hooks';
import { signedMillions } from './model';
import '../cap.css';
import './forecast.css';

export const NONE = '—';

/** The project and the year the person is looking at, kept in the address so a move to the other screen of the pair, or back, keeps them. */
export function useChoice(offered: readonly ProjectOption[]) {
  const [params, setParams] = useSearchParams();
  const selected = offered.find((project) => project.id === params.get('project')) ?? offered[0];
  const typedYear = params.get('year') ?? String(new Date().getFullYear());
  const set = (name: string, value: string): void => {
    const next = new URLSearchParams(params);
    next.set(name, value);
    setParams(next, { replace: true });
  };
  return { selected, typedYear, year: yearOf(typedYear), chooseProject: (id: string) => set('project', id), chooseYear: (value: string) => set('year', value) };
}

export interface PickerProps {
  id: string;
  offered: readonly ProjectOption[];
  selected: ProjectOption;
  typedYear: string;
  yearValid: boolean;
  onProject(id: string): void;
  onYear(value: string): void;
}

/** The choice of the project and the year whose estimates are shown. */
export function Picker({ id, offered, selected, typedYear, yearValid, onProject, onYear }: PickerProps) {
  const { t } = useTranslation();
  return (
    <div className="card cap-filters">
      <div className="field" data-field={`${id}-project`}>
        <label htmlFor={`${id}-project`}>{t('cap.forecast.project.label')}</label>
        <select id={`${id}-project`} value={selected.id} onChange={(event) => onProject(event.target.value)}>
          {offered.map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </select>
      </div>
      <Field id={`${id}-year`} label={t('cap.forecast.year.label')} error={yearValid ? undefined : t('cap.forecast.year.invalid.error', { min: MIN_YEAR, max: MAX_YEAR })}>
        <input id={`${id}-year`} inputMode="numeric" value={typedYear} aria-invalid={!yearValid} maxLength={4} onChange={(event) => onYear(event.target.value)} />
      </Field>
    </div>
  );
}

/**
 * The year-end estimate (EAC) of the project as DIS gives it: what the Treasury paid up to the cut-off, the estimate to the end of the year, the plan and the gap between them. It is read, never worked out here, and it
 * moves when an estimate is entered. Whoever may not read DIS is told so; a failed read has its own card in the panel and leaves the rest of the screen as it is.
 */
export function EacPanel({ projectId, allowed }: { projectId: string; allowed: boolean }) {
  const { t, locale } = useTranslation();
  const estimate = useProjectEstimate(projectId, allowed);
  const state = useScreenState({ isLoading: estimate.isLoading, error: estimate.error, data: estimate.isSuccess ? estimate.data : undefined, isEmpty: (data) => data === null });
  const value = estimate.data ?? undefined;
  if (!allowed) {
    return (
      <p className="callout" role="status" data-testid="eac-hidden">
        {t('cap.forecast.eac.hidden.notice')}
      </p>
    );
  }
  return (
    <div className="card" data-testid="eac">
      <h2>{t('cap.forecast.eac.title')}</h2>
      <StateBoundary state={state} onRetry={() => void estimate.refetch()}>
        {value === undefined ? null : (
          <dl className="cap-facts">
            <dt>{t('cap.forecast.eac.disbursed')}</dt>
            <dd data-testid="eac-disbursed">{value.disbursedVnd === null ? NONE : <Money vnd={value.disbursedVnd} />}</dd>
            <dt>{t('cap.forecast.eac.estimate')}</dt>
            <dd data-testid="eac-estimate">{value.eacVnd === null ? NONE : <Money vnd={value.eacVnd} />}</dd>
            <dt>{t('cap.forecast.eac.plan')}</dt>
            <dd data-testid="eac-plan">
              <Money vnd={value.planTotalVnd} />
            </dd>
            <dt>{t('cap.forecast.eac.gap')}</dt>
            <dd data-testid="eac-gap">{value.gapVnd === null ? NONE : signedMillions(value.gapVnd, locale)}</dd>
            <dt>{t('cap.forecast.eac.coverage')}</dt>
            <dd data-testid="eac-coverage">
              {value.coverage === 'COMPLETE' ? t('dis.forecast.coverage.complete') : value.coverage === 'PARTIAL' ? t('dis.forecast.coverage.partial') : t('dis.forecast.coverage.none')}
            </dd>
            <dt>{t('cap.forecast.eac.asof')}</dt>
            <dd>{t('cap.forecast.eac.cutoff', { month: value.cutoffMonth, year: value.planYear })}</dd>
          </dl>
        )}
      </StateBoundary>
    </div>
  );
}
