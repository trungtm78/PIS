import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field, errorOf } from '../components';
import { useEngagement } from '../hooks';
import { engagementStatusLabel } from '../labels';
import { ENGAGEMENT_PATH, todayInVietnam } from '../model';
import type { EngagementDetail } from '../model';
import '../aud.css';
import { EngagementPicker } from './components';
import { RecommendationDialog } from './dialogs';
import { useConclusions, useFindings, useRecommendations, useRecordConclusion } from './hooks';
import { conclusionFormProblemMessage, conclusionKindLabel, conclusionProblemMessage, conclusionStatusLabel, recommendationStatusLabel, recommendationTypeLabel } from './labels';
import {
  CONCLUSION_KINDS,
  EMPTY_CONCLUSION_FORM,
  FINDINGS_PATH,
  awaitsConclusion,
  canRecord,
  conclusionBody,
  currentOf,
  describeProblem,
  formatVnd,
  takesMore,
  validateConclusion,
} from './model';
import type { ConclusionForm, ConclusionLine, RecommendationLine } from './model';

const NONE = '—';

/**
 * AUD-04: the conclusion of an engagement as DOC received it, and the recommendations on it (ST-AUD-002, AUD 3.2). Recording it moves the engagement to FOLLOW_UP; the financial
 * recommendations never add up to more than its total (BR-AUD-05), and what is not yet covered is shown as a shortfall until the coordinator has dealt with it. The data are confidential:
 * an engagement outside the scope of the caller is not found.
 */
export default function ConclusionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ConclusionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ConclusionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const engagement = useEngagement(engagementId);
  const conclusions = useConclusions(engagementId);
  const missing = engagement.error instanceof ApiError && engagement.error.status === 404;
  const loaded = useScreenState({
    isLoading: engagement.isLoading || conclusions.isLoading,
    error: missing ? undefined : (engagement.error ?? conclusions.error),
    data: engagement.data,
    isEmpty: (data) => data === undefined,
  });
  // An engagement that is not found is told as empty: whoever asked cannot tell one of another scope from one that is not there. With none chosen there is nothing to load.
  const state: ScreenState = engagementId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = engagement.data;
  const current = currentOf(conclusions.data ?? []);
  const mayRecord = canRecord(permissions, mode);
  const retry = (): void => {
    void engagement.refetch();
    void conclusions.refetch();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.conclusion.page.title')}</h1>
          <p>{t('aud.conclusion.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="conclusion-rule">
        {t('aud.conclusion.rule.note')}
      </p>
      <EngagementPicker selected={engagementId} />
      <StateBoundary state={state} onRetry={retry}>
        {detail === undefined ? (
          <p className="muted" data-testid="conclusion-choose">
            {t('aud.conclusion.choose.text')}
          </p>
        ) : (
          <>
            <EngagementCard engagement={detail} hasConclusion={current !== undefined} />
            {current === undefined ? (
              <NoConclusion engagement={detail} mayRecord={mayRecord} />
            ) : (
              <ConclusionView conclusion={current} engagement={detail} mayRecord={mayRecord} />
            )}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('aud.conclusion.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EngagementCard({ engagement, hasConclusion }: { engagement: EngagementDetail; hasConclusion: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="engagement-card">
      <h2>{t('aud.conclusion.engagement.title', { code: engagement.code })}</h2>
      <p>{engagement.title}</p>
      <p>
        <span className="aud-badge">{engagementStatusLabel(t, engagement.status)}</span>
      </p>
      <p className="aud-links">
        <Link to={`${ENGAGEMENT_PATH}?engagement=${engagement.id}`}>{t('aud.conclusion.engagement.file.link')}</Link>
        {hasConclusion ? <Link to={`${FINDINGS_PATH}?engagement=${engagement.id}`}>{t('aud.conclusion.findings.link')}</Link> : null}
      </p>
    </div>
  );
}

/** An engagement that has no conclusion yet: the form when the fieldwork is going on or has ended and the caller may record, the reason it cannot be recorded otherwise. */
function NoConclusion({ engagement, mayRecord }: { engagement: EngagementDetail; mayRecord: boolean }) {
  const { t } = useTranslation();
  if (!awaitsConclusion(engagement.status)) {
    return (
      <p className="callout" data-testid="conclusion-not-ready">
        {t('aud.conclusion.notReady.note')}
      </p>
    );
  }
  if (!mayRecord) {
    return (
      <p className="callout" data-testid="conclusion-read-only">
        {t('aud.conclusion.readOnly.note')}
      </p>
    );
  }
  return <ConclusionFormPanel engagement={engagement} />;
}

function ConclusionFormPanel({ engagement }: { engagement: EngagementDetail }) {
  const { t } = useTranslation();
  const record = useRecordConclusion();
  const today = todayInVietnam();
  const [form, setForm] = useState<ConclusionForm>(EMPTY_CONCLUSION_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateConclusion(form, today);
  const error = (field: keyof ConclusionForm): string | undefined => errorOf(problems, submitted, field, (problem) => conclusionFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ engagementId: engagement.id, version: engagement.version, body: conclusionBody(form) });
  };
  const failure = record.isError ? describeProblem(record.error) : undefined;
  return (
    <form className="card" onSubmit={submit} noValidate data-testid="conclusion-form">
      <h2>{t('aud.conclusion.form.title')}</h2>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {conclusionProblemMessage(t, failure.problem, failure.remainingVnd)}
        </p>
      )}
      <div className="aud-form-grid">
        <Field id="conclusion-kind" label={t('aud.conclusion.form.kind.label')} error={error('kind')}>
          <select id="conclusion-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ConclusionForm['kind'] })}>
            <option value="">{t('aud.conclusion.form.kind.choose')}</option>
            {CONCLUSION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {conclusionKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="conclusion-document" label={t('aud.conclusion.form.document.label')} error={error('documentId')} hint={t('aud.conclusion.form.document.help')}>
          <input id="conclusion-document" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
        </Field>
        <Field id="conclusion-issued-on" label={t('aud.conclusion.form.issuedOn.label')} error={error('issuedOn')}>
          <input id="conclusion-issued-on" type="date" max={today} value={form.issuedOn} onChange={(event) => setForm({ ...form, issuedOn: event.target.value })} />
        </Field>
        <Field id="conclusion-received-on" label={t('aud.conclusion.form.receivedOn.label')} error={error('receivedOn')}>
          <input id="conclusion-received-on" type="date" max={today} value={form.receivedOn} onChange={(event) => setForm({ ...form, receivedOn: event.target.value })} />
        </Field>
        <Field id="conclusion-implementation-due" label={t('aud.conclusion.form.implementationDue.label')} error={error('implementationDueOn')} hint={t('aud.conclusion.form.implementationDue.help')}>
          <input id="conclusion-implementation-due" type="date" value={form.implementationDueOn} onChange={(event) => setForm({ ...form, implementationDueOn: event.target.value })} />
        </Field>
        <Field id="conclusion-report-due" label={t('aud.conclusion.form.reportDue.label')} error={error('reportDueOn')}>
          <input id="conclusion-report-due" type="date" value={form.reportDueOn} onChange={(event) => setForm({ ...form, reportDueOn: event.target.value })} />
        </Field>
        <Field id="conclusion-total" label={t('aud.conclusion.form.total.label')} error={error('totalVnd')} hint={t('aud.conclusion.form.total.help')}>
          <input id="conclusion-total" inputMode="numeric" value={form.totalVnd} onChange={(event) => setForm({ ...form, totalVnd: event.target.value })} />
        </Field>
        <div className="field">
          <label className="check" htmlFor="conclusion-public">
            <input id="conclusion-public" type="checkbox" checked={form.isPublic} onChange={(event) => setForm({ ...form, isPublic: event.target.checked })} />
            {t('aud.conclusion.form.public.label')}
          </label>
        </div>
        <div className="wide">
          <Field id="conclusion-summary" label={t('aud.conclusion.form.summary.label')} error={error('summary')}>
            <textarea id="conclusion-summary" rows={5} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
          </Field>
        </div>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={record.isPending}>
          {record.isPending ? t('aud.conclusion.form.submit.pending') : t('aud.conclusion.form.submit.action')}
        </button>
      </div>
    </form>
  );
}

function ConclusionView({ conclusion, engagement, mayRecord }: { conclusion: ConclusionLine; engagement: EngagementDetail; mayRecord: boolean }) {
  const { t } = useTranslation();
  const findings = useFindings(conclusion.id);
  const recommendations = useRecommendations(conclusion.id);
  const [adding, setAdding] = useState(false);
  const shortfall = conclusion.shortfallVnd !== '0';
  const mayAdd = mayRecord && takesMore(engagement.status, conclusion);
  // The table keeps its rows when there are none: the empty words are the table's, not the screen's.
  const recommendationState = useScreenState({ isLoading: recommendations.isLoading, error: recommendations.error, data: recommendations.data, isEmpty: () => false });
  return (
    <>
      <div className="aud-cards">
        <div className="card" data-testid="conclusion-card">
          <h2>{t('aud.conclusion.view.title', { revision: conclusion.revision })}</h2>
          <dl className="aud-facts">
            <dt>{t('aud.conclusion.view.kind')}</dt>
            <dd>{conclusionKindLabel(t, conclusion.kind)}</dd>
            <dt>{t('aud.conclusion.view.status')}</dt>
            <dd>
              <span className="aud-badge">{conclusionStatusLabel(t, conclusion.status)}</span>
            </dd>
            <dt>{t('aud.conclusion.view.document')}</dt>
            <dd>{conclusion.document.title === '' ? conclusion.document.id : conclusion.document.title}</dd>
            <dt>{t('aud.conclusion.view.symbol')}</dt>
            <dd>{conclusion.document.symbol ?? NONE}</dd>
            <dt>{t('aud.conclusion.view.issuedOn')}</dt>
            <dd>{conclusion.issuedOn}</dd>
            <dt>{t('aud.conclusion.view.receivedOn')}</dt>
            <dd>{conclusion.receivedOn}</dd>
            <dt>{t('aud.conclusion.view.implementationDue')}</dt>
            <dd>{conclusion.implementationDueOn ?? NONE}</dd>
            <dt>{t('aud.conclusion.view.reportDue')}</dt>
            <dd>{conclusion.reportDueOn ?? NONE}</dd>
            <dt>{t('aud.conclusion.view.publicity')}</dt>
            <dd>{conclusion.isPublic ? t('aud.conclusion.view.public.yes') : t('aud.conclusion.view.public.no')}</dd>
          </dl>
        </div>
        <div className="card" data-testid="money-card">
          <h2>{t('aud.conclusion.money.title')}</h2>
          <dl className="aud-facts">
            <dt>{t('aud.conclusion.money.total')}</dt>
            <dd data-testid="money-total">{formatVnd(conclusion.totalVnd)}</dd>
            <dt>{t('aud.conclusion.money.recommended')}</dt>
            <dd data-testid="money-recommended">{formatVnd(conclusion.recommendedVnd)}</dd>
            <dt>{t('aud.conclusion.money.shortfall')}</dt>
            <dd data-testid="money-shortfall">{formatVnd(conclusion.shortfallVnd)}</dd>
          </dl>
          {shortfall ? (
            <p className="callout warning" role="status" data-testid="shortfall">
              {t('aud.conclusion.shortfall.warning', { amount: formatVnd(conclusion.shortfallVnd) })}
            </p>
          ) : (
            <p className="callout" data-testid="shortfall">
              {t('aud.conclusion.shortfall.none')}
            </p>
          )}
        </div>
      </div>
      <div className="card" data-testid="summary-card">
        <h2>{t('aud.conclusion.summary.title')}</h2>
        <p className="aud-words">{conclusion.summary}</p>
      </div>
      <div className="card">
        <div className="heading">
          <div>
            <h2>{t('aud.conclusion.recommendations.title')}</h2>
          </div>
          {mayAdd ? (
            <div className="actions">
              <button type="button" className="primary" onClick={() => setAdding(true)}>
                {t('aud.conclusion.recommendations.add.action')}
              </button>
            </div>
          ) : null}
        </div>
        <StateBoundary state={recommendationState} onRetry={() => void recommendations.refetch()}>
          <RecommendationTable lines={recommendations.data ?? []} />
        </StateBoundary>
      </div>
      {adding ? <RecommendationDialog conclusion={conclusion} findings={findings.data ?? []} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function RecommendationTable({ lines }: { lines: readonly RecommendationLine[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) {
    return (
      <p className="muted" data-testid="no-recommendations">
        {t('aud.conclusion.recommendations.none')}
      </p>
    );
  }
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>{t('aud.conclusion.recommendations.col.code')}</th>
            <th>{t('aud.conclusion.recommendations.col.type')}</th>
            <th>{t('aud.conclusion.recommendations.col.amount')}</th>
            <th>{t('aud.conclusion.recommendations.col.recovered')}</th>
            <th>{t('aud.conclusion.recommendations.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} data-recommendation-id={line.id}>
              <td>
                <strong>{line.code}</strong>
                <div className="sub">{line.description}</div>
              </td>
              <td>{recommendationTypeLabel(t, line.type)}</td>
              <td>{line.amountVnd === null ? NONE : formatVnd(line.amountVnd)}</td>
              <td>{line.amountVnd === null ? NONE : formatVnd(line.recoveredVnd)}</td>
              <td>
                <span className="aud-badge">{recommendationStatusLabel(t, line.status)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
