import { ApiError } from '@machvon/api-client';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { CountInfo, DeniedBlock, EmptyBlock, ErrorBlock } from '../int-common';
import { useMachineAccount, useMachineAccounts } from '../int-hooks';
import { instantText } from '../int-model';
import type { MachineAccount, MachineAccountPage, MachineCredential } from '../int-model';
import { credentialStateLabel, scopeLabel } from './account-labels';
import { SCOPES_PATH } from './AccountsScreen';
import '../int.css';

type T = Translator['t'];

const CREDENTIAL_TONE: Readonly<Record<string, Tone>> = { ACTIVE: 'success', RETIRING: 'warning', EXPIRED: 'neutral', REVOKED: 'neutral' };
const ACCOUNTS_PATH = '/int/int-01';
const NEVER_EMPTY = (): boolean => false;
const NO_FILTERS: Readonly<Record<string, string | undefined>> = {};

interface ScopeRow {
  code: string;
  dataset: string | null;
  holders: number;
}

/**
 * INT-02, "Scopes and keys" (INT-1): the scopes the open API knows (what each reads, and the dataset behind it), and, for one account, every credential it holds: the client id, the first characters of the secret, the
 * state, and the overlap of a rotation. The secret itself is never shown here: it was shown once, when it was made.
 */
export default function ScopesKeysScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScopesKeysContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScopesKeysContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const accountId = search.get('account') ?? undefined;
  const list = useMachineAccounts(NO_FILTERS);
  const detail = useMachineAccount(accountId);
  const first = list.data?.pages[0];
  const accounts = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const denied = state === 'denied';
  const scopes: ScopeRow[] = (first?.scopes ?? []).map((scope) => ({ code: scope.code, dataset: scope.dataset_code, holders: accounts.filter((account) => account.status !== 'REVOKED' && account.scopes.includes(scope.code)).length }));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('int.keys.page.title')}</h1>
          <p>{t('int.keys.page.subtitle')}</p>
        </div>
        <div className="actions int-actions">
          <Link className="ui-button ui-button--outline" to={ACCOUNTS_PATH}>
            {t('int.keys.action.back')}
          </Link>
        </div>
      </div>
      <p className="callout" data-testid="secret-note">
        {t('int.keys.note.secret')}
      </p>
      {denied ? (
        <DeniedBlock title={t('int.keys.denied.title')} body={t('int.keys.denied.body')} />
      ) : state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
        <ErrorBlock title={t('int.keys.error.title')} body={t('int.keys.error.body')} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <SectionCard
            title={t('int.keys.scopes.title')}
            status={
              first === undefined ? undefined : (
                <span>
                  {t('int.keys.scopes.asOf', { time: instantText(first.as_of) })}{' '}
                  <CountInfo name={t('int.keys.info.name')} formula={t('int.keys.info.formula')} source={t('int.keys.info.source')} asOf={instantText(first.as_of)} owner={t('int.keys.info.owner')} />
                </span>
              )
            }
          >
            <DataTable
              caption={t('int.keys.scopes.caption')}
              columns={scopeColumns(t)}
              rows={scopes}
              rowKey={(row) => row.code}
              rowAttrs={(row) => ({ 'data-scope': row.code })}
              state={state === 'loading' ? 'loading' : 'ready'}
              emptyKind="none"
            />
            {first !== undefined && <p className="sub">{t('int.keys.scopes.note', { count: accounts.length })}</p>}
          </SectionCard>
          <AccountKeys accountId={accountId} accounts={accounts} page={first} detail={detail} />
        </>
      )}
      <p className="prototype-note">{t('int.keys.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function scopeColumns(t: T): Array<DataTableColumn<ScopeRow>> {
  return [
    { key: 'code', header: t('int.keys.scopes.column.code'), pinned: true, render: (row) => <span className="int-code">{row.code}</span> },
    { key: 'label', header: t('int.keys.scopes.column.label'), render: (row) => scopeLabel(t, row.code) },
    { key: 'dataset', header: t('int.keys.scopes.column.dataset'), render: (row) => row.dataset ?? t('int.keys.cell.register') },
    { key: 'holders', header: t('int.keys.scopes.column.holders'), align: 'right', render: (row) => row.holders },
  ];
}

function AccountKeys({ accountId, accounts, page, detail }: { accountId: string | undefined; accounts: MachineAccount[]; page: MachineAccountPage | undefined; detail: ReturnType<typeof useMachineAccount> }) {
  const { t } = useTranslation();
  if (accountId === undefined) {
    return (
      <SectionCard title={t('int.keys.pick.title')}>
        {accounts.length === 0 ? (
          <EmptyBlock title={t('int.keys.pick.empty.title')} body={t('int.keys.pick.empty.body')} />
        ) : (
          <ul className="int-columns" aria-label={t('int.keys.pick.list.label')}>
            {accounts.map((account) => (
              <li key={account.id}>
                <Link to={`${SCOPES_PATH}?account=${account.id}`}>{account.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    );
  }
  if (detail.isError) {
    return detail.error instanceof ApiError && detail.error.status === 404 ? (
      <EmptyBlock title={t('int.keys.notFound.title')} body={t('int.keys.notFound.body')} />
    ) : (
      <ErrorBlock title={t('int.keys.error.title')} body={t('int.keys.error.body')} onRetry={() => void detail.refetch()} />
    );
  }
  const account = detail.data;
  if (account === undefined) return <SectionCard title={t('int.keys.account.loading')}>{t('int.keys.account.loading')}</SectionCard>;
  const snippet = `curl -X POST ${page?.token_url ?? '/open/v1/token'} -H 'content-type: application/json' -d '{"grant_type":"client_credentials","client_id":"${account.credentials[0]?.client_id ?? '<client_id>'}","client_secret":"<client_secret>"}'`;
  return (
    <SectionCard title={t('int.keys.account.title', { name: account.name })} status={<StatusPill tone="info">{account.status}</StatusPill>}>
      <DataTable
        caption={t('int.keys.credentials.caption')}
        columns={credentialColumns(t)}
        rows={account.credentials}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-credential-id': row.id, 'data-state': row.state })}
        state="ready"
        emptyKind="none"
      />
      <p className="sub">{t('int.keys.credentials.overlap')}</p>
      <h3>{t('int.keys.call.title')}</h3>
      <p className="sub">{t('int.keys.call.intro', { url: page?.token_url ?? '/open/v1/token' })}</p>
      <pre className="int-snippet" data-testid="call-snippet">
        {snippet}
      </pre>
    </SectionCard>
  );
}

function credentialColumns(t: T): Array<DataTableColumn<MachineCredential>> {
  const none = t('int.keys.cell.none');
  return [
    { key: 'clientId', header: t('int.keys.credentials.column.clientId'), pinned: true, render: (row) => <span className="int-code">{row.client_id}</span> },
    { key: 'hint', header: t('int.keys.credentials.column.hint'), render: (row) => <code>{row.secret_hint}</code> },
    {
      key: 'state',
      header: t('int.keys.credentials.column.state'),
      render: (row) => <StatusPill tone={CREDENTIAL_TONE[row.state] ?? 'neutral'}>{credentialStateLabel(t, row.state)}</StatusPill>,
    },
    { key: 'created', header: t('int.keys.credentials.column.created'), render: (row) => instantText(row.created_at) },
    { key: 'superseded', header: t('int.keys.credentials.column.superseded'), render: (row) => (row.superseded_at === null ? none : instantText(row.superseded_at)) },
    { key: 'expires', header: t('int.keys.credentials.column.expires'), render: (row) => (row.expires_at === null ? none : instantText(row.expires_at)) },
    { key: 'lastUsed', header: t('int.keys.credentials.column.lastUsed'), render: (row) => (row.last_used_at === null ? t('int.keys.cell.neverUsed') : instantText(row.last_used_at)) },
  ];
}
