import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink } from '../components';
import { LIST_PATH } from '../model';
import { ReasonDialog, EvaluateDialog } from './ChangeDialogs';
import { ChangeBadge, Figures, ProjectPicker } from './components';
import { useChain } from './hooks';
import { stageLabel } from './labels';
import { STAGES, inStage, requestLink, tiersLink } from './model';
import type { Chain, ChangeRequest } from './model';
import '../ctr.css';

type Open = { kind: 'promote' | 'withdraw' | 'evaluate'; request: ChangeRequest };

/**
 * CTR-19: the board of the chain of changes of a project (ST-CTR-006, CTR 3.3): a column for each tier the project uses, the requests in the scope of the caller in each, and for
 * each one what the caller may do with it now: promote it to the next tier, assess it (a PCO or a CO) or withdraw it. A guest contractor sees the tier and the status of the requests
 * of its own contract and nothing of the assessment. The server judges every command again.
 */
export default function ChainScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board and its dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ChainContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChainContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('project');
  const contractId = search.get('contract');
  const chain = useChain(projectId, contractId);
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const state = useScreenState({
    isLoading: chain.isLoading,
    error: chain.error,
    data: projectId === null ? null : chain.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const close = (): void => setOpen(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.change.board.title')}</h1>
          <p>{t('ctr.change.board.subtitle')}</p>
        </div>
      </div>
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      {projectId === null ? (
        <ProjectPicker onPick={(id) => setSearch({ project: id })} />
      ) : (
        <StateBoundary state={state} onRetry={() => void chain.refetch()}>
          {chain.data === null || chain.data === undefined ? null : <Board chain={chain.data} contractId={contractId} locale={locale} readOnly={mode === 'READ_ONLY'} onOpen={setOpen} />}
        </StateBoundary>
      )}
      {open === undefined ? null : open.kind === 'evaluate' ? (
        <EvaluateDialog key={`${open.request.id}:${open.request.version}`} request={open.request} onClose={close} />
      ) : (
        <ReasonDialog key={`${open.request.id}:${open.request.version}:${open.kind}`} kind={open.kind} request={open.request} onClose={close} />
      )}
      <p className="prototype-note">{t('ctr.change.board.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface BoardProps {
  chain: Chain;
  contractId: string | null;
  locale: string;
  readOnly: boolean;
  onOpen(open: Open): void;
}

function Board({ chain, contractId, locale, readOnly, onOpen }: BoardProps) {
  const { t } = useTranslation();
  const { config } = chain;
  // A project that has not set its tiers has no requests; a guest contractor does not read the tiers and sees the tiers its own requests are at.
  const stages = config?.stages ?? STAGES.filter((stage) => inStage(chain.requests, stage).length > 0);
  return (
    <>
      <article className="card" aria-label={t('ctr.change.tiers.title')} data-testid="tiers">
        <h2>{t('ctr.change.tiers.title')}</h2>
        {config === undefined ? (
          <p className="callout" role="status" data-testid="not-configured">
            {chain.canConfigure ? t('ctr.change.tiers.none.staff') : t('ctr.change.tiers.none.reader')}
          </p>
        ) : (
          <p data-testid="tier-chain">
            {t('ctr.change.tiers.count', { count: config.tierCount })}: {config.stages.map((stage) => stageLabel(t, stage)).join(' → ')}
            {config.locked ? (
              <>
                {' · '}
                <span className="ctr-badge" data-testid="locked">
                  {t('ctr.change.tiers.locked.badge')}
                </span>
              </>
            ) : null}
          </p>
        )}
        {config?.locked === true && config.lockedBy !== null ? (
          <p className="sub" data-testid="locked-by">
            {t('ctr.change.tiers.locked.by', { code: config.lockedBy.code ?? config.lockedBy.id })}
          </p>
        ) : null}
        <div className="ctr-row-actions">
          {chain.canConfigure ? (
            <Link className="button" to={tiersLink(chain.projectId)} data-testid="tiers-link">
              {t('ctr.change.tiers.link')}
            </Link>
          ) : null}
          {chain.canOpen && !readOnly && config !== undefined ? (
            <Link className="button primary" to={requestLink(contractId ?? undefined)} data-testid="open-link">
              {t('ctr.change.open.link')}
            </Link>
          ) : null}
        </div>
      </article>
      {chain.requests.length === 0 ? (
        <p className="callout" role="status" data-testid="no-requests">
          {t('ctr.change.board.empty')}
        </p>
      ) : (
        <div className="ctr-board" data-testid="board">
          {stages.map((stage) => (
            <section key={stage} className="ctr-column" data-stage={stage} aria-label={stageLabel(t, stage)}>
              <h2>
                {stageLabel(t, stage)} <span className="sub">({inStage(chain.requests, stage).length})</span>
              </h2>
              {inStage(chain.requests, stage).map((request) => (
                <Card key={request.id} request={request} locale={locale} readOnly={readOnly} onOpen={onOpen} />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

interface CardProps {
  request: ChangeRequest;
  locale: string;
  readOnly: boolean;
  onOpen(open: Open): void;
}

function Card({ request, locale, readOnly, onOpen }: CardProps) {
  const { t } = useTranslation();
  const may = (kind: Open['kind']): boolean => !readOnly && request.actions?.[kind] === true;
  const buttons = (['promote', 'evaluate', 'withdraw'] as const).filter(may);
  const statusReason = request.detail?.statusReason ?? null;
  return (
    <article className="card ctr-card" data-request={request.id} aria-label={request.code ?? request.id}>
      <p>
        <strong data-testid="request-code">{request.code ?? request.id}</strong> <ChangeBadge status={request.status} />
      </p>
      <p className="sub" data-testid="request-contract">
        {request.contract.code}
      </p>
      {request.detail === undefined ? null : <p data-testid="request-reason">{request.detail.reason}</p>}
      <Figures request={request} locale={locale} />
      {statusReason === null ? null : (
        <p className="sub" data-testid="request-status-reason">
          {statusReason}
        </p>
      )}
      {buttons.length === 0 ? null : (
        <div className="ctr-row-actions" data-testid="request-actions">
          {buttons.map((kind) => (
            <button key={kind} type="button" className={kind === 'promote' ? 'button primary' : 'button'} data-command={kind} onClick={() => onOpen({ kind, request })}>
              {kind === 'promote' ? t('ctr.change.action.promote') : kind === 'evaluate' ? t('ctr.change.action.evaluate') : t('ctr.change.action.withdraw')}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
