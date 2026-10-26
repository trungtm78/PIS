import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useEngagement } from '../hooks';
import '../aud.css';
import { EngagementPicker } from './components';
import { FindingDialog } from './dialogs';
import { useConclusions, useFindings } from './hooks';
import { findingCategoryLabel, findingSeverityLabel } from './labels';
import { CONCLUSIONS_PATH, canRecord, currentOf, formatVnd, takesMore } from './model';
import type { ConclusionLine, FindingLine } from './model';
import type { EngagementDetail } from '../model';

const NONE = '—';

/**
 * AUD-05: the findings of the conclusion of an engagement (ST-AUD-002, AUD 3.2): what was found, in which group and how grave, the project or contract and the unit it is about, the amount it
 * concerns and the rule it breaks. A finding is about a place of the engagement and nothing else. The data are confidential: an engagement outside the scope of the caller is not found.
 */
export default function FindingsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <FindingsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function FindingsContent({ route }: ScreenProps) {
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
          <h1 id="screen-title">{t('aud.finding.page.title')}</h1>
          <p>{t('aud.finding.page.subtitle')}</p>
        </div>
      </div>
      <EngagementPicker selected={engagementId} />
      <StateBoundary state={state} onRetry={retry}>
        {detail === undefined ? (
          <p className="muted" data-testid="finding-choose">
            {t('aud.finding.choose.text')}
          </p>
        ) : current === undefined ? (
          <p className="callout" data-testid="finding-no-conclusion">
            {t('aud.finding.noConclusion.note')} <Link to={`${CONCLUSIONS_PATH}?engagement=${detail.id}`}>{t('aud.finding.noConclusion.link')}</Link>
          </p>
        ) : (
          <FindingList engagement={detail} conclusion={current} mayRecord={mayRecord} />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('aud.finding.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function FindingList({ engagement, conclusion, mayRecord }: { engagement: EngagementDetail; conclusion: ConclusionLine; mayRecord: boolean }) {
  const { t } = useTranslation();
  const findings = useFindings(conclusion.id);
  const [adding, setAdding] = useState(false);
  // The table keeps its rows when there are none: the empty words are the table's, not the screen's.
  const state = useScreenState({ isLoading: findings.isLoading, error: findings.error, data: findings.data, isEmpty: () => false });
  const mayAdd = mayRecord && takesMore(engagement.status, conclusion);
  return (
    <div className="card">
      <div className="heading">
        <div>
          <h2>{t('aud.finding.list.title', { code: engagement.code })}</h2>
          <p className="sub">
            <Link to={`${CONCLUSIONS_PATH}?engagement=${engagement.id}`}>{t('aud.finding.list.conclusion.link')}</Link>
          </p>
        </div>
        {mayAdd ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setAdding(true)}>
              {t('aud.finding.add.action')}
            </button>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void findings.refetch()}>
        <FindingTable lines={findings.data ?? []} />
      </StateBoundary>
      {adding ? <FindingDialog conclusion={conclusion} scope={engagement.scope} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function FindingTable({ lines }: { lines: readonly FindingLine[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) {
    return (
      <p className="muted" data-testid="no-findings">
        {t('aud.finding.none.text')}
      </p>
    );
  }
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>{t('aud.finding.col.code')}</th>
            <th>{t('aud.finding.col.category')}</th>
            <th>{t('aud.finding.col.place')}</th>
            <th>{t('aud.finding.col.unit')}</th>
            <th>{t('aud.finding.col.amount')}</th>
            <th>{t('aud.finding.col.severity')}</th>
            <th>{t('aud.finding.col.legalBasis')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} data-finding-id={line.id}>
              <td>
                <strong>{line.code}</strong>
                <div className="sub">{line.description}</div>
              </td>
              <td>{findingCategoryLabel(t, line.category)}</td>
              <td>{line.project !== null ? `${line.project.code} · ${line.project.name}` : line.contract !== null ? line.contract.code : NONE}</td>
              <td>{line.unit === null ? NONE : line.unit.name}</td>
              <td>{line.amountVnd === null ? NONE : formatVnd(line.amountVnd)}</td>
              <td>
                <span className="aud-badge">{findingSeverityLabel(t, line.severity)}</span>
              </td>
              <td>{line.legalBasis ?? NONE}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
