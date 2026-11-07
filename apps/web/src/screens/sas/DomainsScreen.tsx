import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useAddDomain, useRemoveDomain, useTenantDomains, useVerifyDomain } from './domains/hooks';
import { kindLabel, problemMessage, statusLabel, statusTone, tlsLabel } from './domains/labels';
import { MANAGE_PERMISSION, MAX_REASON, READ_PERMISSION, canRemove, canVerify, choosesTenant, describeProblem, isHostnameValid, isReasonValid } from './domains/model';
import type { ChallengeView, DomainKind, DomainView } from './domains/model';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './billing/billing.css';
import { toneOfPill } from '../adm/kit-tone';

/** The type of the DNS record of the proof: a protocol name, not a word to translate. */
const RECORD_TYPE = 'TXT';

type Doing = { what: 'verify' | 'remove'; domainId: string; tenantId: string | undefined };

/**
 * SAS-05: the domains of a tenant (BR-SAS-06). The System Admin attaches a hostname to a tenant, a custom one proved by a TXT record whose value is shown once, when the domain is added; verifying looks for the record in the
 * DNS and, once it is there, the platform gives the domain a certificate and makes it Active. A domain that is Verified or Active chooses the tenant that the sign-in starts from; it gives no membership to anybody. A released
 * domain is final and its hostname is held for 90 days. The registry readers see the list and the states; only the System Admin writes.
 */
export default function DomainsScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const canManage = permissions !== undefined && permissions.includes(MANAGE_PERMISSION);
  const canRead = canManage || (permissions !== undefined && permissions.includes(READ_PERMISSION));
  if (!canRead) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
        <div className="heading">
          <div>
            <h1 id="screen-title">{t('sas.domain.page.title')}</h1>
          </div>
        </div>
        <p className="callout warning" role="alert">
          {t('states.denied.title')}
        </p>
      </section>
    );
  }
  // The forms and the notices belong to one membership: a switch starts the screen over.
  return <DomainsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} canManage={canManage} />;
}

function DomainsContent({ route, canManage }: ScreenProps & { canManage: boolean }) {
  const { t, locale } = useTranslation();
  const choice = useTenantChoice();
  const domains = useTenantDomains(choice.chosen, true);
  const add = useAddDomain();
  const verify = useVerifyDomain();
  const remove = useRemoveDomain();
  const [hostname, setHostname] = useState('');
  const [kind, setKind] = useState<DomainKind>('CUSTOM');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<ReadonlySet<'hostname' | 'reason'>>(new Set());
  // What was prepared belongs to the tenant it was prepared for: choosing another tenant leaves it behind, so an action meant for one never reaches another.
  const [doing, setDoing] = useState<Doing | undefined>(undefined);
  const [challenge, setChallenge] = useState<{ view: ChallengeView; tenantId: string | undefined } | undefined>(undefined);
  const [notice, setNotice] = useState<{ what: 'added' | 'verified' | 'removed'; tenantId: string | undefined } | undefined>(undefined);
  const acting = doing !== undefined && doing.tenantId === choice.chosen ? doing : undefined;
  const shownChallenge = challenge !== undefined && challenge.tenantId === choice.chosen ? challenge.view : undefined;
  const shownNotice = notice !== undefined && notice.tenantId === choice.chosen ? notice.what : undefined;

  const state = useScreenState({ isLoading: domains.isLoading, error: domains.error, data: domains.data, isEmpty: () => false });
  const items = (domains.data?.pages ?? []).flatMap((page) => page.items);
  const problem = add.isError ? describeProblem(add.error) : verify.isError ? describeProblem(verify.error) : remove.isError ? describeProblem(remove.error) : undefined;
  const busy = add.isPending || verify.isPending || remove.isPending;
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const target = acting === undefined ? undefined : items.find((entry) => entry.id === acting.domainId);

  const resetCommands = (): void => {
    add.reset();
    verify.reset();
    remove.reset();
  };

  const pick = (tenantId: string): void => {
    setDoing(undefined);
    setChallenge(undefined);
    setNotice(undefined);
    setReason('');
    setInvalid(new Set());
    resetCommands();
    choice.choose(tenantId);
  };

  const open = (what: Doing['what'], entry: DomainView): void => {
    resetCommands();
    setNotice(undefined);
    setInvalid(new Set());
    setReason('');
    setDoing({ what, domainId: entry.id, tenantId: choice.chosen });
  };

  const submitAdd = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canManage || choice.chosen === undefined) return;
    if (!isHostnameValid(hostname)) {
      setInvalid(new Set(['hostname']));
      return;
    }
    resetCommands();
    setNotice(undefined);
    setChallenge(undefined);
    const tenantId = choice.chosen;
    add.mutate(
      { tenantId, hostname: hostname.trim(), kind },
      {
        onSuccess: (view) => {
          // The value is kept here only, for as long as the screen is: it is never stored again.
          if (view !== undefined && view.txtRecordValue !== '') setChallenge({ view, tenantId });
          setNotice({ what: 'added', tenantId });
          setHostname('');
          setInvalid(new Set());
        },
      },
    );
  };

  const submitAction = (event: FormEvent): void => {
    event.preventDefault();
    if (acting === undefined || target === undefined || busy || !canManage || choice.chosen === undefined) return;
    if (!isReasonValid(reason)) {
      setInvalid(new Set(['reason']));
      return;
    }
    const input = { tenantId: choice.chosen, domainId: target.id, version: target.version, reason: reason.trim() };
    const finished = {
      onSuccess: () => {
        setNotice({ what: acting.what === 'verify' ? 'verified' : 'removed', tenantId: choice.chosen });
        setDoing(undefined);
        setReason('');
        setInvalid(new Set());
      },
    };
    if (acting.what === 'verify') verify.mutate(input, finished);
    else remove.mutate(input, finished);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.domain.page.title')}</h1>
          <p>{t('sas.domain.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="domain-tenant" label={t('sas.domain.tenant.label')} moreLabel={t('sas.domain.tenant.more.action')} choice={{ ...choice, choose: pick }} />
      {canManage ? (
        <SectionCard title={t('sas.domain.add.title')}>
          <p className="sub">{t('sas.domain.add.rule')}</p>
          <form onSubmit={submitAdd} noValidate aria-label={t('sas.domain.add.aria')} className="billing-issue">
            <div className="field">
              <label htmlFor="domain-hostname">{t('sas.domain.add.hostname.label')}</label>
              <input id="domain-hostname" type="text" autoComplete="off" spellCheck={false} value={hostname} aria-invalid={invalid.has('hostname')} onChange={(event) => setHostname(event.target.value)} />
              <small className="sub">{t('sas.domain.add.hostname.hint')}</small>
              {invalid.has('hostname') ? (
                <small role="alert" className="field-error">
                  {t('sas.domain.add.hostname.invalid')}
                </small>
              ) : null}
            </div>
            <fieldset className="field">
              <legend>{t('sas.domain.add.kind.legend')}</legend>
              <label>
                <input type="radio" name="domain-kind" checked={kind === 'CUSTOM'} onChange={() => setKind('CUSTOM')} /> {t('sas.domain.kind.custom')}
              </label>{' '}
              <label>
                <input type="radio" name="domain-kind" checked={kind === 'PLATFORM_SUBDOMAIN'} onChange={() => setKind('PLATFORM_SUBDOMAIN')} /> {t('sas.domain.kind.platform')}
              </label>
            </fieldset>
            <div className="row gap">
              <button type="submit" className="ui-button ui-button--primary" disabled={busy || choice.chosen === undefined}>
                {t('sas.domain.add.submit.action')}
              </button>
            </div>
          </form>
        </SectionCard>
      ) : null}
      {shownChallenge === undefined ? null : (
        <div className="callout" role="status" data-challenge>
          <h2>{t('sas.domain.challenge.title')}</h2>
          <p>{t('sas.domain.challenge.rule')}</p>
          <dl className="kv">
            <dt>{t('sas.domain.challenge.type')}</dt>
            <dd>{RECORD_TYPE}</dd>
            <dt>{t('sas.domain.challenge.name')}</dt>
            <dd>
              <code data-txt-name>{shownChallenge.txtRecordName}</code>
            </dd>
            <dt>{t('sas.domain.challenge.value')}</dt>
            <dd>
              <code data-txt-value>{shownChallenge.txtRecordValue}</code>
            </dd>
            {shownChallenge.expiresAt === undefined ? null : (
              <>
                <dt>{t('sas.domain.challenge.expires')}</dt>
                <dd>{day(shownChallenge.expiresAt)}</dd>
              </>
            )}
          </dl>
          <p className="sub">{t('sas.domain.challenge.once')}</p>
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setChallenge(undefined)}>
            {t('sas.domain.challenge.hide.action')}
          </button>
        </div>
      )}
      {shownNotice === undefined ? null : (
        <p className="callout" role="status">
          {shownNotice === 'added' ? t('sas.domain.done.added') : shownNotice === 'verified' ? t('sas.domain.done.verified') : t('sas.domain.done.removed')}
        </p>
      )}
      {problem === undefined ? null : (
        <div className="callout warning" role="alert">
          <p>{problemMessage(t, problem)}</p>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void domains.refetch()}>
        <SectionCard title={t('sas.domain.list.title')}>
          <p className="sub">{t('sas.domain.list.rule')}</p>
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.domain.list.none')}
            </p>
          ) : (
            <KitTable caption={t('w2sas.domains.table.caption')} data-domains>
              <thead>
                <tr>
                  <th scope="col">{t('sas.domain.column.domain')}</th>
                  <th scope="col">{t('sas.domain.column.status')}</th>
                  <th scope="col">{t('sas.domain.column.txt')}</th>
                  <th scope="col">{t('sas.domain.column.tls')}</th>
                  <th scope="col">{t('sas.domain.column.checked')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('sas.domain.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id} data-domain-id={entry.id} data-status={entry.status}>
                    <td>
                      <code>{entry.hostname}</code>
                      <br />
                      <small className="sub">{kindLabel(t, entry.kind)}</small>
                    </td>
                    <td>
                      <StatusPill tone={toneOfPill(toneClass(statusTone(entry.status)))}>{statusLabel(t, entry.status)}</StatusPill>
                      {entry.failureCode === undefined ? null : <small className="sub"> · {entry.failureCode}</small>}
                      {choosesTenant(entry) ? <small className="sub" data-chooses> · {t('sas.domain.chooses')}</small> : null}
                      {entry.status === 'Revoked' && entry.reservedUntil !== undefined ? <small className="sub" data-reserved> · {t('sas.domain.reservedUntil', { at: day(entry.reservedUntil) })}</small> : null}
                    </td>
                    <td data-txt>
                      {entry.txtRecordName === undefined ? '—' : <code>{entry.txtRecordName}</code>}
                      {entry.challengeExpiresAt !== undefined && entry.txtRecordName !== undefined ? <small className="sub"> · {t('sas.domain.challengeUntil', { at: day(entry.challengeExpiresAt) })}</small> : null}
                    </td>
                    <td>
                      {entry.status === 'Revoked' ? '—' : tlsLabel(t, entry.tlsStatus)}
                      {entry.tlsExpiresAt === undefined || entry.status === 'Revoked' ? null : <small className="sub"> · {t('sas.domain.tlsUntil', { at: day(entry.tlsExpiresAt) })}</small>}
                    </td>
                    <td>{entry.lastCheckedAt === undefined ? '—' : day(entry.lastCheckedAt)}</td>
                    <td>
                      {canManage ? (
                        <div className="row gap">
                          {canVerify(entry) ? (
                            <button type="button" disabled={busy} onClick={() => open('verify', entry)}>
                              {t('sas.domain.verify.action')}
                            </button>
                          ) : null}
                          {canRemove(entry) ? (
                            <button type="button" disabled={busy} onClick={() => open('remove', entry)}>
                              {t('sas.domain.remove.action')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          {domains.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={domains.isFetchingNextPage} onClick={() => void domains.fetchNextPage()}>
                {t('sas.domain.list.more.action')}
              </button>
            </div>
          ) : null}
          {acting === undefined || target === undefined ? null : (
            <form onSubmit={submitAction} noValidate aria-label={t('sas.domain.act.aria')} className="billing-issue">
              <p className="callout">{acting.what === 'verify' ? t('sas.domain.verify.rule', { host: target.hostname }) : t('sas.domain.remove.rule', { host: target.hostname })}</p>
              <div className="field">
                <label htmlFor="domain-reason">{t('sas.domain.act.reason.label')}</label>
                <textarea id="domain-reason" rows={2} maxLength={MAX_REASON} value={reason} aria-invalid={invalid.has('reason')} onChange={(event) => setReason(event.target.value)} />
                {invalid.has('reason') ? (
                  <small role="alert" className="field-error">
                    {t('sas.domain.act.reason.tooShort')}
                  </small>
                ) : null}
              </div>
              <div className="row gap">
                <button type="submit" className="ui-button ui-button--primary" disabled={busy}>
                  {t('sas.domain.act.confirm.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDoing(undefined)}>
                  {t('sas.domain.act.abort.action')}
                </button>
              </div>
            </form>
          )}
        </SectionCard>
      </StateBoundary>
    </section>
  );
}
