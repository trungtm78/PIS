import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { can, dayText, stampText, vnd } from '../claims/common';
import { BackLink } from '../claims/components';
import { PATHS as CLAIM_PATHS } from '../claims/model';
import { useWarning } from './hooks';
import { actionStatusLabel, categoryLabel, likelihoodLabel, partyLabel, reviewLabel, statusLabel } from './labels';
import { CLOSE_PERMISSION, MANAGE_PERMISSION, PATHS, isOpen } from './model';
import type { Warning, WarningAction } from './model';
import { WarningDialogs } from './WarningDialogs';
import type { WarningDialog } from './WarningDialogs';
import '../claims/claims.css';

const NONE = '–';

/**
 * CTR-36, one early warning (G1-15): who raised it and when, the assessment (the person who answers for it, the likelihood and the expected impact on time and cost), the mitigation actions with a person and a day each, the meetings that
 * reviewed it and how it ended. It is closed as resolved only without open actions and by somebody other than the person who answers for it; one that came true names the change order or the claim it became.
 */
export default function EarlyWarningRecordScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  return <RecordContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('warning') ?? ''}`} route={route} warningId={params.get('warning')} />;
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd {...(testId === undefined ? {} : { 'data-testid': testId })}>{children}</dd>
    </>
  );
}

function RecordContent({ route, warningId }: ScreenProps & { warningId: string | null }) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const query = useWarning(warningId);
  const [dialog, setDialog] = useState<WarningDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const warning: Warning | undefined = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: warning === undefined ? query.error : undefined, data: warning, isEmpty: () => false });
  const frozen = mode === 'READ_ONLY';
  const canManage = can(permissions, MANAGE_PERMISSION, frozen);
  const canClose = can(permissions, CLOSE_PERMISSION, frozen);

  if (warningId === null) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title">
        <h1 id="screen-title">{t('ctrWarn.record.page.title')}</h1>
        <div className="card" role="status" data-testid="no-warning">
          <p>{t('ctrWarn.record.noWarning.text')}</p>
          <Link to={PATHS.register}>{t('ctrWarn.record.toRegister.action')}</Link>
        </div>
      </section>
    );
  }

  const open = (next: WarningDialog): void => {
    setReceipt(undefined);
    setDialog(next);
  };
  const actionColumns = (current: Warning): DataTableColumn<WarningAction>[] => [
    { key: 'description', header: t('ctrWarn.action.column.description.label'), pinned: true, render: (action) => action.description },
    { key: 'owner', header: t('ctrWarn.action.column.owner.label'), render: (action) => action.owner_name ?? NONE },
    { key: 'due', header: t('ctrWarn.action.column.due.label'), render: (action) => dayText(action.due_on) },
    {
      key: 'status',
      header: t('ctrWarn.action.column.status.label'),
      render: (action) => (
        <span data-testid="action-status" data-status={action.status} data-overdue={action.overdue ? 'true' : 'false'}>
          <StatusPill tone={action.overdue ? 'danger' : action.status === 'DONE' ? 'success' : action.status === 'CANCELLED' ? 'neutral' : 'info'}>
            {action.overdue ? t('ctrWarn.action.overdue.label') : actionStatusLabel(t, action.status)}
          </StatusPill>
        </span>
      ),
    },
    { key: 'done', header: t('ctrWarn.action.column.done.label'), render: (action) => (action.done_on === null ? NONE : `${dayText(action.done_on)} · ${action.done_by_name ?? NONE}`) },
    { key: 'note', header: t('ctrWarn.action.column.note.label'), render: (action) => action.done_note ?? NONE },
    {
      key: 'commands',
      header: t('ctrWarn.action.column.commands.label'),
      render: (action) =>
        canManage && action.status === 'OPEN' && isOpen(current.status) ? (
          <span className="ctrreg-row-actions">
            <button type="button" className="ui-button ui-button--small ui-button--primary" onClick={() => open({ kind: 'complete', warning: current, action, outcome: 'DONE' })} data-testid="action-done">
              {t('ctrWarn.action.done.action')}
            </button>
            <button type="button" className="ui-button ui-button--small ui-button--outline" onClick={() => open({ kind: 'complete', warning: current, action, outcome: 'CANCELLED' })} data-testid="action-cancel">
              {t('ctrWarn.action.cancel.action')}
            </button>
          </span>
        ) : (
          NONE
        ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ctrreg-page">
      <BackLink to={warning === undefined ? PATHS.register : `${PATHS.register}?contract=${warning.contract.id}`}>{t('ctrWarn.record.back.action')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{warning === undefined ? t('ctrWarn.record.page.title') : `${warning.code} · ${warning.title}`}</h1>
          <p>{t('ctrWarn.record.page.subtitle')}</p>
        </div>
        {warning !== undefined && (
          <div className="actions" data-testid="status">
            <StatusPill tone={isOpen(warning.status) ? 'info' : warning.status === 'CLOSED_RESOLVED' ? 'success' : 'neutral'}>{statusLabel(t, warning.status)}</StatusPill>
          </div>
        )}
      </div>
      {warning !== undefined && <ContextBar items={[{ label: t('ctrWarn.dialog.contract.label'), value: warning.contract.code }]} stale={query.isError} asOf={stampText(warning.as_of)} unit={t('ctrWarn.unit.vnd.text')} />}
      {receipt !== undefined && (
        <p className="ctrreg-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {warning !== undefined && (
          <>
            <SectionCard title={t('ctrWarn.record.facts.title')}>
              <dl className="ctrreg-facts">
                <Fact label={t('ctrWarn.record.contract.label')}>
                  <Link to={`${PATHS.register}?contract=${warning.contract.id}`}>{warning.contract.code}</Link>
                </Fact>
                <Fact label={t('ctrWarn.record.description.label')}>{warning.description}</Fact>
                <Fact label={t('ctrWarn.record.category.label')}>{categoryLabel(t, warning.category)}</Fact>
                <Fact label={t('ctrWarn.record.party.label')}>{partyLabel(t, warning.raised_by_party)}</Fact>
                <Fact label={t('ctrWarn.record.raisedBy.label')}>{`${warning.raised_by_name ?? NONE} · ${dayText(warning.raised_on)}`}</Fact>
              </dl>
            </SectionCard>

            <SectionCard
              title={t('ctrWarn.record.assessment.title')}
              actions={
                canManage && warning.allowed.assess ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open({ kind: 'assess', warning })} data-testid="assess-button">
                    {t('ctrWarn.record.assess.action')}
                  </button>
                ) : undefined
              }
            >
              {warning.status === 'RAISED' ? (
                <p data-testid="unassessed">{t('ctrWarn.record.unassessed.text')}</p>
              ) : (
                <dl className="ctrreg-facts" data-testid="assessment">
                  <Fact label={t('ctrWarn.record.owner.label')}>{warning.owner_name ?? NONE}</Fact>
                  <Fact label={t('ctrWarn.record.likelihood.label')}>{warning.likelihood === null ? NONE : likelihoodLabel(t, warning.likelihood)}</Fact>
                  <Fact label={t('ctrWarn.record.time.label')} testId="time">
                    {warning.expected_time_days !== null ? t('ctrWarn.record.days.text', { days: warning.expected_time_days }) : warning.no_impact_expected ? t('ctrWarn.cell.noImpact.text') : NONE}
                  </Fact>
                  <Fact label={t('ctrWarn.record.cost.label')} testId="cost">
                    {warning.expected_cost_vnd !== null ? vnd(warning.expected_cost_vnd, locale) : warning.no_impact_expected ? t('ctrWarn.cell.noImpact.text') : NONE}
                  </Fact>
                  <Fact label={t('ctrWarn.record.assessedBy.label')}>{warning.assessed_by_name === null ? NONE : `${warning.assessed_by_name} · ${stampText(warning.assessed_at)}`}</Fact>
                </dl>
              )}
            </SectionCard>

            <SectionCard
              title={t('ctrWarn.record.actions.title')}
              actions={
                canManage && warning.allowed.add_action ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open({ kind: 'action', warning })} data-testid="add-action-button">
                    {t('ctrWarn.record.addAction.action')}
                  </button>
                ) : undefined
              }
            >
              <DataTable caption={t('ctrWarn.record.actions.caption')} columns={actionColumns(warning)} rows={warning.actions} rowKey={(action) => action.id} severity={(action) => (action.overdue ? 'ACTION' : null)} emptyKind="none" />
              {warning.status === 'ASSESSED' && warning.actions.length === 0 && <p className="sub">{t('ctrWarn.record.noActions.text')}</p>}
            </SectionCard>

            <SectionCard title={t('ctrWarn.record.reviews.title')}>
              {warning.reviews.length === 0 ? (
                <p className="sub" data-testid="no-reviews">
                  {t('ctrWarn.record.reviews.none.text')}
                </p>
              ) : (
                <ol className="ctrreg-timeline" data-testid="reviews">
                  {warning.reviews.map((review) => (
                    <li key={review.meeting_id}>
                      <strong>{dayText(review.held_on)}</strong>
                      <span>{reviewLabel(t, review.outcome)}</span>
                      <span className="sub">{statusLabel(t, review.status_at_meeting)}</span>
                      {review.note !== null && <p>{review.note}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>

            <SectionCard
              title={t('ctrWarn.record.closure.title')}
              actions={
                canClose && warning.allowed.close ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open({ kind: 'close', warning })} data-testid="close-button">
                    {t('ctrWarn.record.close.action')}
                  </button>
                ) : undefined
              }
            >
              {isOpen(warning.status) ? (
                <p className="sub">{t('ctrWarn.record.closure.open.text')}</p>
              ) : (
                <dl className="ctrreg-facts" data-testid="closure">
                  <Fact label={t('ctrWarn.record.closedBy.label')}>{`${warning.closed_by_name ?? NONE} · ${stampText(warning.closed_at)}`}</Fact>
                  <Fact label={t('ctrWarn.record.closedReason.label')}>{warning.closed_reason ?? NONE}</Fact>
                  {warning.change_request_id !== null && <Fact label={t('ctrWarn.record.becameChange.label')}>{warning.change_request_id}</Fact>}
                  {warning.claim_id !== null && (
                    <Fact label={t('ctrWarn.record.becameClaim.label')}>
                      <Link to={`${CLAIM_PATHS.record}?claim=${warning.claim_id}`}>{warning.claim_id}</Link>
                    </Fact>
                  )}
                </dl>
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      {dialog !== undefined && (
        <WarningDialogs
          dialog={dialog}
          onClose={() => setDialog(undefined)}
          onDone={(text) => {
            setReceipt(text);
            setDialog(undefined);
          }}
        />
      )}
    </section>
  );
}
