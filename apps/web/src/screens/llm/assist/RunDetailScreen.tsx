import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { ScreenFrame } from './assist-components';
import { useAssistRun, usePermit } from './assist-hooks';
import { kindLabel } from './assist-labels';
import { ASSIST_USE, PATHS, failureStatus, isUuid, shortId, stamp } from './assist-model';
import { RunView } from './run-view';

/**
 * LLM-23, one run of the assistant and the decision of the person (AI.01, AI.04): the statements by what they rest on, with their citations checked again against what the reader may read now (a citation the reader may not
 * read is counted, never shown), the instruction-like text found in the sources, and the one decision a run takes: accepted, accepted with changes, or rejected. A statement without a verified source can never be kept.
 * The run is named in the link, `?run=<id>`.
 */
export default function RunDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const id = (params.get('run') ?? '').trim().toLowerCase();
  // What is open belongs to one membership of one tenant: a switch starts the screen over.
  return <RunDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id}`} route={route} id={id} />;
}

function RunDetailContent({ route, id }: ScreenProps & { id: string }) {
  const { t } = useTranslation();
  const permit = usePermit();
  const valid = isUuid(id);
  const query = useAssistRun(valid ? id : undefined);
  const run = query.data;
  const state = useScreenState({ isLoading: valid && query.isLoading, error: valid ? query.error : undefined, data: run, isEmpty: () => false });
  const notFound = failureStatus(query.error) === 404;
  const refreshFailed = query.isError && run !== undefined;
  const back = (
    <Link to={PATHS.assistant} className="ui-button ui-button--outline">
      {t('llm.assist.detail.back')}
    </Link>
  );
  return (
    <ScreenFrame
      screenId={route.id}
      title={t('llm.assist.detail.title')}
      subtitle={t('llm.assist.detail.subtitle')}
      context={run === undefined ? [] : [{ label: t('llm.assist.detail.context.run'), value: shortId(run.id) }, { label: t('llm.assist.detail.context.kind'), value: kindLabel(t, run.kind) }, { label: t('llm.assist.detail.context.asked'), value: stamp(run.createdAt) }]}
      stale={refreshFailed}
      actions={
        <>
          {back}
          {run === undefined ? null : (
            <button type="button" className="ui-button ui-button--outline" onClick={() => void query.refetch()} disabled={query.isFetching} data-testid="reload-run">
              {t('llm.assist.detail.reload')}
            </button>
          )}
        </>
      }
    >
      {!permit.has(ASSIST_USE) ? (
        <StateBoundary state="denied" />
      ) : !valid ? (
        <SectionCard title={t('llm.assist.detail.noRun.title')}>
          <p data-testid="no-run">{t('llm.assist.detail.noRun.text')}</p>
        </SectionCard>
      ) : notFound ? (
        <SectionCard title={t('llm.assist.detail.notFound.title')}>
          <p role="alert" data-testid="run-not-found">
            {t('llm.assist.detail.notFound.text')}
          </p>
        </SectionCard>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {refreshFailed ? (
            <p className="callout warning" role="alert" data-testid="stale-note">
              {t('llm.assist.detail.stale')}
            </p>
          ) : null}
          {run === undefined ? null : <RunView run={run} />}
        </StateBoundary>
      )}
    </ScreenFrame>
  );
}
