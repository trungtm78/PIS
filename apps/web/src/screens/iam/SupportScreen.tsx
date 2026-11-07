import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTickets } from './support/hooks';
import { categoryLabel, priorityLabel, statusLabel } from './support/labels';
import { SUPPORT_CREATE_PERMISSION, formatInstant, isOverdue } from './support/model';
import { TicketForm } from './support/TicketForm';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';

// A member without a ticket yet still has the form to raise the first: that is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/**
 * IAM-08: help and support tickets. The member raises a ticket and sees their own with the code, what it is about, how urgent it is, where it stands and the
 * time by which the operator of the platform must have answered. The operator sees the metadata and the SLA of a ticket, never the data of the tenant: to see it
 * they ask for a support access, which the owner of the tenant approves, and a ticket alone does not open it.
 */
export default function SupportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The tickets listed are the membership's own: a switch starts the screen over.
  return <SupportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SupportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const tickets = useTickets();
  const [raised, setRaised] = useState<string | undefined | null>(null);
  const state = useScreenState({ isLoading: tickets.isLoading, error: tickets.error, data: tickets.data, isEmpty: NEVER_EMPTY });
  const mayRaise = (permissions === undefined || permissions.includes(SUPPORT_CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const list = tickets.data ?? [];
  const now = new Date();
  const justRaised = raised === null ? undefined : list.find((ticket) => ticket.id === raised);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.support.page.title')}</h1>
          <p>{t('iam.support.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void tickets.refetch()}>
        <div className="stack">
          {raised === null ? null : (
            <p className="callout" role="status" data-testid="raised">
              {justRaised === undefined ? t('iam.support.raised.notice') : t('iam.support.raised.code.notice', { code: justRaised.code })}
            </p>
          )}
          <SectionCard title={t('iam.support.list.title')}>
            {list.length === 0 ? (
              <p className="sub" data-testid="no-tickets">
                {t('iam.support.list.empty.text')}
              </p>
            ) : (
              <KitTable caption={t('w2iam.support.table.caption')} data-testid="tickets" aria-label={t('iam.support.list.aria')}>
                <thead>
                  <tr>
                    <th scope="col">{t('iam.support.column.code')}</th>
                    <th scope="col">{t('iam.support.column.subject')}</th>
                    <th scope="col">{t('iam.support.column.priority')}</th>
                    <th scope="col">{t('iam.support.column.status')}</th>
                    <th scope="col">{t('iam.support.column.sla')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((ticket) => {
                    const overdue = isOverdue(ticket, now);
                    return (
                      <tr key={ticket.id} data-ticket-id={ticket.id} data-status={ticket.status} data-overdue={overdue}>
                        <th scope="row">
                          <code>{ticket.code}</code>
                        </th>
                        <td>
                          {ticket.subject}
                          <br />
                          <small className="sub">
                            {categoryLabel(t, ticket.category)}
                            {ticket.own ? '' : ` · ${t('iam.support.other.text')}`}
                            {ticket.attachmentCount === 0 ? '' : ` · ${t('iam.support.attachments.text', { count: ticket.attachmentCount })}`}
                          </small>
                        </td>
                        <td>{priorityLabel(t, ticket.priority)}</td>
                        <td>
                          <StatusPill tone={ticket.status === 'Closed' ? 'neutral' : ticket.status === 'Resolved' ? 'success' : ticket.status === 'WaitingCustomer' ? 'warning' : 'info'}>{statusLabel(t, ticket.status)}</StatusPill>
                        </td>
                        <td>
                          {formatInstant(ticket.slaDueAt)}
                          {overdue ? (
                            <>
                              <br />
                              <span data-testid="overdue">
                                <StatusPill tone="warning">{t('iam.support.overdue.label')}</StatusPill>
                              </span>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </KitTable>
            )}
          </SectionCard>
          {mayRaise ? <TicketForm onRaised={setRaised} /> : <p className="sub">{t('iam.support.readonly.text')}</p>}
          <p className="sub" data-testid="privacy">
            {t('iam.support.privacy.text')}
          </p>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('iam.support.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
