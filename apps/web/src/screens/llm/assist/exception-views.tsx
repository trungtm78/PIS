import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { classificationLabel, routeLabel } from '../labels';
import { DetailDrawer, Facts, Field, SectionDenied, SectionFailed } from './assist-components';
import { useEditionPolicy, useException, useExceptions, usePermit } from './assist-hooks';
import type { useAssistProviders } from './assist-hooks';
import { exceptionStatusLabel, exceptionStatusTone, routingNote } from './assist-labels';
import { EXCEPTION_APPROVE, EXCEPTION_READ, EXCEPTION_REQUEST, EXCEPTION_STATUSES, PROVIDER_MANAGE, PROVIDER_READ, failureStatus, isAttested, isExternal, shortId, stamp } from './assist-model';
import type { ExceptionRow, ExceptionStatus, ProviderRow } from './assist-model';
import { AttestDialog, DecideDialog, RequestDialog, RevokeDialog } from './exception-dialogs';
import type { DecisionKind } from './exception-dialogs';

type Dialog =
  | { kind: 'attest'; provider: ProviderRow }
  | { kind: 'request' }
  | { kind: 'decide'; row: ExceptionRow; decision: DecisionKind }
  | { kind: 'revoke'; row: ExceptionRow };

export interface SectionProps {
  onReceipt: (text: string) => void;
}

// ---- the policy of the edition ---------------------------------------------------------------------------------------------------------------------------------------------

/** What the edition says about providers outside the customer servers: off by default (an approved, logged exception is needed to use one) or left to the routing policy of the tenant. */
export function PolicyBanner() {
  const { t } = useTranslation();
  const permit = usePermit();
  const policy = useEditionPolicy();
  if (!permit.has(PROVIDER_READ)) return <SectionDenied what={t('llm.exceptions.policy.title')} />;
  if (failureStatus(policy.error) === 403) return <SectionDenied what={t('llm.exceptions.policy.title')} />;
  if (policy.isError) return <SectionFailed what={t('llm.exceptions.policy.title')} onRetry={() => void policy.refetch()} />;
  if (policy.data === undefined) {
    return (
      <p className="callout" role="status" aria-busy="true" data-testid="policy-loading">
        {t('llm.exceptions.policy.loading')}
      </p>
    );
  }
  const required = policy.data.externalRouting === 'EXCEPTION_REQUIRED';
  return (
    <div className={required ? 'callout warning' : 'callout'} role="status" data-testid="policy-banner" data-routing={policy.data.externalRouting}>
      <strong>{routingNote(t, policy.data.externalRouting)}</strong>
      {policy.data.attestationRequired ? <p>{t('llm.exceptions.policy.attestation')}</p> : null}
      <p className="sub">{t('llm.exceptions.policy.name', { name: policy.data.name })}</p>
    </div>
  );
}

// ---- the providers and their attestations ------------------------------------------------------------------------------------------------------------------------------

export function ProvidersSection({ onReceipt, providers }: SectionProps & { providers: ReturnType<typeof useAssistProviders> }) {
  const { t } = useTranslation();
  const permit = usePermit();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const rows = providers.data ?? [];
  const forbidden = !permit.has(PROVIDER_READ) || failureStatus(providers.error) === 403;
  return (
    <SectionCard title={t('llm.exceptions.providers.title')}>
      {forbidden ? (
        <SectionDenied what={t('llm.exceptions.providers.title')} />
      ) : providers.isError ? (
        <SectionFailed what={t('llm.exceptions.providers.title')} onRetry={() => void providers.refetch()} />
      ) : (
        <DataTable<ProviderRow>
          caption={t('llm.exceptions.providers.caption')}
          rows={rows}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-provider-id': row.id, 'data-attested': isAttested(row) ? 'true' : 'false' })}
          state={providers.isLoading ? 'loading' : 'ready'}
          columns={[
            {
              key: 'provider',
              header: t('llm.exceptions.column.provider'),
              pinned: true,
              render: (row) => (
                <>
                  {row.name}
                  <span className="sub"> · {row.code}</span>
                </>
              ),
            },
            { key: 'route', header: t('llm.exceptions.column.route'), render: (row) => routeLabel(t, row.route) },
            { key: 'class', header: t('llm.exceptions.column.class'), render: (row) => (row.maxClassification === null ? '–' : classificationLabel(t, row.maxClassification)) },
            {
              key: 'location',
              header: t('llm.exceptions.column.location'),
              render: (row) =>
                row.country === null ? (
                  <StatusPill tone="warning">{t('llm.exceptions.location.none')}</StatusPill>
                ) : (
                  <span data-testid="location">
                    {row.country}
                    {row.locationDetail === null ? '' : ` · ${row.locationDetail}`}
                  </span>
                ),
            },
            {
              key: 'training',
              header: t('llm.exceptions.column.training'),
              render: (row) =>
                row.noTrainingAttested === null ? (
                  <StatusPill tone={isExternal(row) ? 'warning' : 'neutral'}>{t('llm.exceptions.training.none')}</StatusPill>
                ) : row.noTrainingAttested ? (
                  <StatusPill tone="success">{t('llm.exceptions.training.yes')}</StatusPill>
                ) : (
                  <StatusPill tone="danger">{t('llm.exceptions.training.no')}</StatusPill>
                ),
            },
            { key: 'reference', header: t('llm.exceptions.column.reference'), render: (row) => row.attestationRef ?? '–' },
            { key: 'attested', header: t('llm.exceptions.column.attested'), render: (row) => (row.attestedBy === null ? '–' : `${shortId(row.attestedBy)} · ${stamp(row.attestedAt)}`) },
            {
              key: 'actions',
              header: t('llm.exceptions.column.actions'),
              render: (row) =>
                permit.can(PROVIDER_MANAGE) && isExternal(row) ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'attest', provider: row })}>
                    {isAttested(row) ? t('llm.exceptions.action.renew', { code: row.code }) : t('llm.exceptions.action.attest', { code: row.code })}
                  </button>
                ) : (
                  '–'
                ),
            },
          ]}
        />
      )}
      {dialog?.kind === 'attest' ? <AttestDialog provider={dialog.provider} onClose={() => setDialog(undefined)} onDone={onReceipt} /> : null}
    </SectionCard>
  );
}

// ---- the exceptions --------------------------------------------------------------------------------------------------------------------------------------------------------------

export function ExceptionsSection({ onReceipt, providers }: SectionProps & { providers: readonly ProviderRow[] }) {
  const { t } = useTranslation();
  const permit = usePermit();
  const [status, setStatus] = useState<ExceptionStatus | ''>('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const list = useExceptions(status);
  const forbidden = !permit.has(EXCEPTION_READ) || failureStatus(list.error) === 403;
  const rows = list.data ?? [];
  return (
    <SectionCard
      title={t('llm.exceptions.list.title')}
      actions={
        permit.can(EXCEPTION_REQUEST) ? (
          <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="request-button" onClick={() => setDialog({ kind: 'request' })}>
            {t('llm.exceptions.request.open')}
          </button>
        ) : undefined
      }
    >
      {forbidden ? (
        <SectionDenied what={t('llm.exceptions.list.title')} />
      ) : (
        <>
          <FilterPanel applied={status === '' ? 0 : 1}>
            <Field id="exceptions-status" label={t('llm.exceptions.list.filterStatus')}>
              <select id="exceptions-status" value={status} onChange={(event) => setStatus(event.target.value as ExceptionStatus | '')}>
                <option value="">{t('llm.exceptions.list.all')}</option>
                {EXCEPTION_STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {exceptionStatusLabel(t, entry)}
                  </option>
                ))}
              </select>
            </Field>
          </FilterPanel>
          {list.isError ? (
            <SectionFailed what={t('llm.exceptions.list.title')} onRetry={() => void list.refetch()} />
          ) : (
            <DataTable<ExceptionRow>
              caption={t('llm.exceptions.list.caption')}
              rows={rows}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ 'data-exception-id': row.id, 'data-status': row.status, 'data-in-force': row.inForce ? 'true' : 'false' })}
              state={list.isLoading ? 'loading' : 'ready'}
              emptyKind={status === '' ? 'none' : 'filtered'}
              onClearFilters={() => setStatus('')}
              columns={[
                { key: 'provider', header: t('llm.exceptions.column.provider'), pinned: true, render: (row) => row.providerCode },
                { key: 'task', header: t('llm.exceptions.column.task'), render: (row) => row.taskType ?? t('llm.exceptions.allTasks') },
                { key: 'class', header: t('llm.exceptions.column.class'), render: (row) => (row.maxClassification === null ? '–' : classificationLabel(t, row.maxClassification)) },
                {
                  key: 'status',
                  header: t('llm.exceptions.column.status'),
                  render: (row) => (
                    <span className="assist-actions">
                      <StatusPill tone={exceptionStatusTone(row.status, row.inForce)}>{exceptionStatusLabel(t, row.status)}</StatusPill>
                      {row.status === 'APPROVED' ? <StatusPill tone={row.inForce ? 'success' : 'neutral'}>{row.inForce ? t('llm.exceptions.inForce.yes') : t('llm.exceptions.inForce.no')}</StatusPill> : null}
                    </span>
                  ),
                },
                { key: 'requested', header: t('llm.exceptions.column.requested'), render: (row) => `${shortId(row.requestedBy)} · ${stamp(row.requestedAt)}` },
                { key: 'validity', header: t('llm.exceptions.column.validUntil'), render: (row) => (row.validUntil === null ? '–' : stamp(row.validUntil)) },
                { key: 'uses', header: t('llm.exceptions.column.uses'), align: 'right', render: (row) => row.useCount },
                {
                  key: 'actions',
                  header: t('llm.exceptions.column.actions'),
                  render: (row) => (
                    <span className="assist-actions">
                      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setOpen(row.id)}>
                        {t('llm.exceptions.action.details', { code: row.providerCode })}
                      </button>
                      {permit.can(EXCEPTION_APPROVE) && row.status === 'REQUESTED' ? (
                        <>
                          <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setDialog({ kind: 'decide', row, decision: 'APPROVE' })}>
                            {t('llm.exceptions.action.approve', { code: row.providerCode })}
                          </button>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'decide', row, decision: 'REJECT' })}>
                            {t('llm.exceptions.action.reject', { code: row.providerCode })}
                          </button>
                        </>
                      ) : null}
                      {permit.can(EXCEPTION_APPROVE) && row.status === 'APPROVED' && row.inForce ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'revoke', row })}>
                          {t('llm.exceptions.action.revoke', { code: row.providerCode })}
                        </button>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      {open === undefined ? null : <ExceptionDrawer id={open} onClose={() => setOpen(undefined)} />}
      {dialog?.kind === 'request' ? <RequestDialog providers={providers} onClose={() => setDialog(undefined)} onDone={onReceipt} /> : null}
      {dialog?.kind === 'decide' ? <DecideDialog row={dialog.row} decision={dialog.decision} onClose={() => setDialog(undefined)} onDone={onReceipt} /> : null}
      {dialog?.kind === 'revoke' ? <RevokeDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={onReceipt} /> : null}
    </SectionCard>
  );
}

// ---- the detail of one exception and the log of its uses -------------------------------------------------------------------------------------------------

function ExceptionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useException(id);
  const row = query.data;
  return (
    <DetailDrawer title={t('llm.exceptions.drawer.title', { code: row?.providerCode ?? shortId(id) })} onClose={onClose}>
      {query.isLoading ? (
        <p role="status" aria-busy="true">
          {t('llm.exceptions.drawer.loading')}
        </p>
      ) : null}
      {failureStatus(query.error) === 403 ? <SectionDenied what={t('llm.exceptions.drawer.title', { code: shortId(id) })} /> : query.isError ? <SectionFailed what={t('llm.exceptions.drawer.title', { code: shortId(id) })} onRetry={() => void query.refetch()} /> : null}
      {row === undefined ? null : (
        <>
          <Facts
            items={[
              { label: t('llm.exceptions.column.status'), value: <StatusPill tone={exceptionStatusTone(row.status, row.inForce)}>{exceptionStatusLabel(t, row.status)}</StatusPill> },
              { label: t('llm.exceptions.column.route'), value: row.routeClass === null ? '–' : routeLabel(t, row.routeClass) },
              { label: t('llm.exceptions.column.task'), value: row.taskType ?? t('llm.exceptions.allTasks') },
              { label: t('llm.exceptions.column.class'), value: row.maxClassification === null ? '–' : classificationLabel(t, row.maxClassification) },
              { label: t('llm.exceptions.decide.reason'), value: row.reason },
              { label: t('llm.exceptions.column.requested'), value: `${shortId(row.requestedBy)} · ${stamp(row.requestedAt)} · ${t('llm.exceptions.drawer.days', { count: row.requestedDays })}` },
              { label: t('llm.exceptions.drawer.decided'), value: row.decidedBy === null ? '–' : `${shortId(row.decidedBy)} · ${stamp(row.decidedAt)}` },
              { label: t('llm.exceptions.drawer.approvalRef'), value: row.approvalRef ?? '–' },
              { label: t('llm.exceptions.drawer.note'), value: row.decisionNote ?? '–' },
              { label: t('llm.exceptions.drawer.valid'), value: row.validFrom === null ? '–' : `${stamp(row.validFrom)} → ${stamp(row.validUntil)}` },
              ...(row.revokedAt === null ? [] : [{ label: t('llm.exceptions.drawer.revoked'), value: `${row.revokedBy === null ? '' : shortId(row.revokedBy)} · ${stamp(row.revokedAt)} · ${row.revokeReason ?? ''}` }]),
            ]}
          />
          <h3>{t('llm.exceptions.drawer.usesTitle', { count: row.useCount })}</h3>
          <DataTable
            caption={t('llm.exceptions.drawer.usesCaption')}
            rows={row.uses}
            rowKey={(use) => use.id}
            columns={[
              { key: 'when', header: t('llm.exceptions.uses.when'), pinned: true, render: (use) => stamp(use.usedAt) },
              { key: 'request', header: t('llm.exceptions.uses.request'), render: (use) => <code>{shortId(use.aiRequestId)}</code> },
              { key: 'task', header: t('llm.exceptions.column.task'), render: (use) => use.taskType },
              { key: 'class', header: t('llm.exceptions.column.class'), render: (use) => (use.classification === null ? '–' : classificationLabel(t, use.classification)) },
              { key: 'route', header: t('llm.exceptions.column.route'), render: (use) => (use.routeClass === null ? '–' : routeLabel(t, use.routeClass)) },
            ]}
          />
        </>
      )}
    </DetailDrawer>
  );
}
