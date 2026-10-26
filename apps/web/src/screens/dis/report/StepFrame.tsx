import { ApiError } from '@machvon/api-client';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ScreenProps } from '../../../routes/types';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink } from '../components';
import '../dis.css';
import { StepNav } from './components';
import { useReport } from './hooks';
import { REPORTS_PATH } from './model';
import type { ReportDetail } from './model';
import type { StepKey } from './step-model';

/** The words of a step of the draft, already in the language of the person: each screen passes its own. */
export interface StepTexts {
  back: string;
  title: string;
  subtitle: string;
  choose: string;
  footer: string;
}

/**
 * The frame the steps of the draft share (DIS-03, DIS-05, DIS-06), and the screens of a report that was handed in (DIS-07, DIS-08, DIS-11), which have no steps: the link back to the list, the title, the steps of the draft, and the report named by `?report=` loaded under the state
 * boundary. A report that is not found is told as empty (whoever asked cannot tell one of another scope from one that is not there); with none chosen there is nothing to load.
 */
export function StepFrame({ route, texts, current, children }: ScreenProps & { texts: StepTexts; current?: StepKey; children: (detail: ReportDetail) => ReactNode }) {
  const [params] = useSearchParams();
  const reportId = params.get('report') ?? undefined;
  const report = useReport(reportId);
  const missing = report.error instanceof ApiError && report.error.status === 404;
  const loaded = useScreenState({ isLoading: report.isLoading, error: missing ? undefined : report.error, data: report.data, isEmpty: (data) => data === undefined });
  const state: ScreenState = reportId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = report.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{texts.back}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{texts.title}</h1>
          <p>{texts.subtitle}</p>
        </div>
      </div>
      {detail === undefined || current === undefined ? null : <StepNav reportId={detail.id} current={current} />}
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {detail === undefined ? (
          <p className="muted" data-testid="report-choose">
            {texts.choose}
          </p>
        ) : (
          children(detail)
        )}
      </StateBoundary>
      <p className="prototype-note">{texts.footer}</p>
    </section>
  );
}
