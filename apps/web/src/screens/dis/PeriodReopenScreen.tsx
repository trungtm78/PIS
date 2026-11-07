import type { ScreenProps } from '../../routes/types';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard } from '../../ui';
import { BackLink } from './components';
import { useNow, usePeriods } from './hooks';
import { REOPEN_APPROVE_PERMISSION, REOPEN_REQUEST_PERMISSION, queueOf } from './model';
import { ReopenQueue } from './ReopenQueue';
import { ReopenRequestForm } from './ReopenRequestForm';

const NEVER_EMPTY = (): boolean => false;
const NONE = '–';
/** The screen DIS-22 is opened from (DIS-21, the close and freeze of the figures of a period). */
const PARENT_PATH = '/dis/dis-21';

/**
 * DIS-22: the reasoned reopening of a locked reporting period (ST-DIS-002, DIS 3 F4). A maker asks for a locked period to be reopened for
 * the whole period or for named projects, with a reason and a window; an approver who is not the requester grants it for the hours they
 * choose, or rejects it. The period stays locked: while a window is open, only the projects it names can be reported on, and each carries
 * "open until hh:mm".
 */
export default function PeriodReopenScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the decision in progress belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReopenContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReopenContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const now = useNow();
  const periods = usePeriods();
  const state = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: NEVER_EMPTY });
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && !frozen;
  const canRequest = holds(REOPEN_REQUEST_PERMISSION);
  const canApprove = holds(REOPEN_APPROVE_PERMISSION);
  const all = periods.data ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={PARENT_PATH}>{t('dis.reopen.back.parent.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reopen.page.title')}</h1>
          <p>{t('dis.reopen.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('w2dis.reopen.ctx.waiting'), value: periods.data === undefined ? NONE : String(queueOf(all).filter((request) => request.reopen.status === 'REQUESTED').length) },
        ]}
      />
      {!canRequest && !canApprove ? (
        <p className="dis-w2-banner dis-w2-banner--info" role="status" data-testid="read-only">
          {frozen ? t('dis.reopen.readOnly.frozen.notice') : t('dis.reopen.readOnly.denied.notice')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        {canRequest ? <ReopenRequestForm periods={all} /> : null}
        <SectionCard title={t('dis.reopen.queue.title')}>
          <ReopenQueue requests={queueOf(all)} now={now} approve={canApprove} me={tenant?.membershipId} />
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('dis.reopen.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
