import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { taskLink } from '../model';
import { useTask } from '../task/hooks';
import { AssignmentLedger } from './AssignmentLedger';
import '../pwf.css';

const NEVER_EMPTY = (): boolean => false;

/** PWF-16: the assignment ledger of one task (`?id=` is the task), as a screen of its own. */
export default function AssignmentLedgerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <LedgerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LedgerContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const taskId = params.get('id');
  const task = useTask(taskId);
  const state = useScreenState({ isLoading: task.isLoading, error: task.error, data: task.data, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {taskId === null ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('pwf.ledger.screen.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-task">
            {t('pwf.ledger.noTask.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void task.refetch()}>
          {task.data === undefined ? null : (
            <>
              <p className="prj-back-link">
                <Link to={taskLink(taskId)}>{t('pwf.ledger.back.link')}</Link>
              </p>
              <div className="heading">
                <h1 id="screen-title">{t('pwf.ledger.screen.heading', { code: task.data.task_code, name: task.data.name })}</h1>
              </div>
              <AssignmentLedger taskId={taskId} canAssign={task.data.can_assign} />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pwf.ledger.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
