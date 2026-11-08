import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { CountInfo, DeniedBlock, EmptyBlock, ErrorBlock, MoreRow, SecretDialog, StatusChips } from '../int-common';
import { useMachineAccounts } from '../int-hooks';
import { ACCOUNT_STATUSES, dayText, filtersOf, instantDay, instantText, searchOf } from '../int-model';
import type { MachineAccount, MachineAccountPage } from '../int-model';
import { AccountDialogs } from './AccountDialogs';
import type { AccountDialog, AccountOutcome } from './AccountDialogs';
import { accountStatusLabel, credentialStateLabel, scopeLabel } from './account-labels';
import '../int.css';

type T = Translator['t'];
type SecretOutcome = Extract<AccountOutcome, { kind: 'secret' }>;

const STATUS_TONE: Readonly<Record<string, Tone>> = { ACTIVE: 'success', SUSPENDED: 'warning', REVOKED: 'neutral' };
const STATUS_ICON: Readonly<Record<string, string>> = { ACTIVE: '✓', SUSPENDED: '❚❚', REVOKED: '✕' };
const FILTERS = ['status', 'q'] as const;
const NEVER_EMPTY = (): boolean => false;
export const SCOPES_PATH = '/int/int-02';

/**
 * INT-01, "Machine accounts" (INT-1): the machines that read through the open API. Each has scopes (what it may read), a rate limit and an end day; opening one and rotating its secret show the secret ONCE
 * (the platform keeps only its hash); suspending acts at once, even on a token still alive; revoking is final. Every command has a reason and the version of the account it was shown.
 */
export default function AccountsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialogs and the secret belong to one membership: a switch of tenant or of membership starts the screen over (and drops a secret).
  return <AccountsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AccountsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search, FILTERS), [search]);
  const list = useMachineAccounts(filters);
  const [dialog, setDialog] = useState<AccountDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [secret, setSecret] = useState<SecretOutcome | undefined>(undefined);
  const frozen = mode === 'READ_ONLY';
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const denied = state === 'denied';
  const mayCreate = first?.can_create === true && !frozen;
  const applied = Object.keys(filters).length;
  const total = first === undefined ? 0 : ACCOUNT_STATUSES.reduce((sum, status) => sum + first.counts[status], 0);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('int.accounts.page.title')}</h1>
          <p>{t('int.accounts.page.subtitle')}</p>
        </div>
        {mayCreate && !denied && (
          <div className="actions int-actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'create' })}>
              {t('int.accounts.action.create')}
            </button>
          </div>
        )}
      </div>
      <p className="callout" data-testid="secret-note">
        {t('int.accounts.note.secret')}
      </p>
      {receipt !== undefined && (
        <p className="callout int-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {first !== undefined && !first.can_create && !denied && (
        <p className="callout" role="status" data-testid="readonly-note">
          {t('int.accounts.readonly.notice')}
        </p>
      )}
      {denied ? (
        <DeniedBlock title={t('int.accounts.denied.title')} body={t('int.accounts.denied.body')} />
      ) : (
        <SectionCard
          title={t('int.accounts.list.title')}
          status={
            first === undefined ? undefined : (
              <span>
                {t('int.accounts.list.asOf', { day: instantDay(first.as_of) })}{' '}
                <CountInfo
                  name={t('int.accounts.info.name')}
                  formula={t('int.accounts.info.formula')}
                  source={t('int.accounts.info.source')}
                  asOf={instantText(first.as_of)}
                  owner={t('int.accounts.info.owner')}
                />
              </span>
            )
          }
        >
          {first !== undefined && (total > 0 || applied > 0) && (
            <StatusChips
              statuses={ACCOUNT_STATUSES}
              counts={first.counts}
              active={filters.status}
              label={t('int.accounts.chip.group.label')}
              allLabel={t('int.accounts.chip.all', { count: total })}
              chipLabel={(status, count) => t('int.accounts.chip.label', { label: accountStatusLabel(t, status), count })}
              onChoose={(status) => setSearch(searchOf({ ...filters, status }))}
            />
          )}
          <FilterBar filters={filters} onChange={(next) => setSearch(searchOf(next))} />
          {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
            <ErrorBlock title={t('int.accounts.error.title')} body={t('int.accounts.error.body')} onRetry={() => void list.refetch()} />
          ) : first !== undefined && applied === 0 && total === 0 && rows.length === 0 ? (
            <EmptyBlock title={t('int.accounts.empty.title')} body={t('int.accounts.empty.body')} />
          ) : (
            <>
              <DataTable
                caption={t('int.accounts.table.caption')}
                columns={columns(t, frozen, setDialog)}
                rows={rows}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-account-id': row.id, 'data-status': row.status })}
                state={state === 'loading' ? 'loading' : 'ready'}
                emptyKind={applied > 0 ? 'filtered' : 'none'}
                onClearFilters={() => setSearch(searchOf({}))}
              />
              {first !== undefined && <MoreRow shown={rows.length} hasNext={list.hasNextPage} loading={list.isFetchingNextPage} failed={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />}
            </>
          )}
        </SectionCard>
      )}
      <AccountDialogs
        dialog={dialog}
        page={first as MachineAccountPage | undefined}
        onClose={() => setDialog(undefined)}
        onDone={(outcome) => {
          if (outcome.kind === 'secret') {
            setReceipt(undefined);
            setSecret(outcome);
          } else {
            setReceipt(outcome.text);
          }
        }}
      />
      {secret !== undefined && (
        <SecretDialog
          title={secret.title === 'created' ? t('int.accounts.secret.created.title', { name: secret.accountName }) : t('int.accounts.secret.rotated.title', { name: secret.accountName })}
          intro={t('int.accounts.secret.intro', { url: secret.tokenUrl })}
          items={[
            { label: t('int.accounts.secret.clientId.label'), value: secret.clientId },
            { label: t('int.accounts.secret.clientSecret.label'), value: secret.clientSecret },
          ]}
          onClose={() => {
            setSecret(undefined);
            setReceipt(secret.title === 'created' ? t('int.accounts.success.created', { name: secret.accountName }) : t('int.accounts.success.rotated', { name: secret.accountName }));
          }}
        />
      )}
      <p className="prototype-note">{t('int.accounts.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function FilterBar({ filters, onChange }: { filters: Record<string, string | undefined>; onChange: (next: Record<string, string | undefined>) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onChange({ ...filters, q: text.trim() === '' ? undefined : text.trim() });
  };
  return (
    <form className="int-filters" role="search" aria-label={t('int.accounts.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="int-accounts-q">{t('int.accounts.filter.q.label')}</label>
        <input id="int-accounts-q" type="search" value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('int.accounts.filter.apply.action')}
      </button>
    </form>
  );
}

function columns(t: T, frozen: boolean, open: (dialog: AccountDialog) => void): Array<DataTableColumn<MachineAccount>> {
  const none = t('int.accounts.cell.none');
  return [
    {
      key: 'name',
      header: t('int.accounts.column.name'),
      pinned: true,
      render: (row) => (
        <span className="int-cell">
          <span className="int-code">{row.name}</span>
          {row.description !== null && <small>{row.description}</small>}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('int.accounts.column.status'),
      render: (row) => (
        <span className="int-cell">
          <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} icon={STATUS_ICON[row.status] ?? '○'}>
            {accountStatusLabel(t, row.status)}
          </StatusPill>
          {row.status_reason !== null && <small>{t('int.accounts.cell.reason', { reason: row.status_reason })}</small>}
        </span>
      ),
    },
    {
      key: 'scopes',
      header: t('int.accounts.column.scopes'),
      render: (row) => (
        <span className="int-scopes">
          {row.scopes.map((scope) => (
            <StatusPill key={scope} tone="info">
              {scopeLabel(t, scope)}
            </StatusPill>
          ))}
        </span>
      ),
    },
    { key: 'rate', header: t('int.accounts.column.rate'), align: 'right', render: (row) => t('int.accounts.cell.rate', { rate: row.rate_limit_per_minute }) },
    { key: 'expires', header: t('int.accounts.column.expires'), render: (row) => (row.expires_on === null ? t('int.accounts.cell.unlimited') : dayText(row.expires_on)) },
    {
      key: 'credentials',
      header: t('int.accounts.column.credentials'),
      render: (row) => (
        <span className="int-cell">
          {row.credentials.slice(0, 2).map((credential) => (
            <small key={credential.id} data-testid="credential">
              {t('int.accounts.cell.credential', { hint: credential.secret_hint, state: credentialStateLabel(t, credential.state) })}
            </small>
          ))}
          {row.credentials.length === 0 && <small>{none}</small>}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      header: t('int.accounts.column.lastUsed'),
      render: (row) => {
        const used = row.credentials.map((credential) => credential.last_used_at).filter((value): value is string => value !== null).sort();
        const last = used[used.length - 1];
        return last === undefined ? t('int.accounts.cell.neverUsed') : instantText(last);
      },
    },
    {
      key: 'actions',
      header: t('int.accounts.column.actions'),
      render: (row) => (
        <span className="int-row-actions">
          <Link className="ui-button ui-button--outline ui-button--small" to={`${SCOPES_PATH}?account=${row.id}`} aria-label={t('int.accounts.action.keys.label', { name: row.name })}>
            {t('int.accounts.action.keys')}
          </Link>
          {!frozen && row.actions.update && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.accounts.action.update.label', { name: row.name })} onClick={() => open({ kind: 'update', account: row })}>
              {t('int.accounts.action.update')}
            </button>
          )}
          {!frozen && row.actions.rotate && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.accounts.action.rotate.label', { name: row.name })} onClick={() => open({ kind: 'rotate', account: row })}>
              {t('int.accounts.action.rotate')}
            </button>
          )}
          {!frozen && row.actions.decide && row.status === 'ACTIVE' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.accounts.action.suspend.label', { name: row.name })} onClick={() => open({ kind: 'decide', account: row, decision: 'SUSPEND' })}>
              {t('int.accounts.action.suspend')}
            </button>
          )}
          {!frozen && row.actions.decide && row.status === 'SUSPENDED' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.accounts.action.reactivate.label', { name: row.name })} onClick={() => open({ kind: 'decide', account: row, decision: 'REACTIVATE' })}>
              {t('int.accounts.action.reactivate')}
            </button>
          )}
          {!frozen && row.actions.decide && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.accounts.action.revoke.label', { name: row.name })} onClick={() => open({ kind: 'decide', account: row, decision: 'REVOKE' })}>
              {t('int.accounts.action.revoke')}
            </button>
          )}
        </span>
      ),
    },
  ];
}
