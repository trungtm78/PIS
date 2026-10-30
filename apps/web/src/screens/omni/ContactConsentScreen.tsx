import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import '../not/delivery/delivery.css';
import { useContacts } from './contact/hooks';
import { useConsents, useGrantConsent, useWithdrawConsent } from './consent/hooks';
import { channelLabel, formProblemMessage, methodLabel, problemMessage, purposeLabel, statusLabel } from './consent/labels';
import { CHANNELS, CONTACT_READ_PERMISSION, MANAGE_PERMISSION, METHODS, PURPOSES, READ_PERMISSION, channelsOf, consentBody, consentProblems, describeProblem, emptyForm, needsEvidence, reasonProblem, takesConsent } from './consent/model';
import type { Consent, ConsentForm } from './consent/model';
import type { Contact } from './contact/model';

/**
 * OMNI-04: the consent of the contacts outside the tenant to be written to. For the contact chosen: what it agreed to (channel, purpose, the version of the terms, how it was taken, since when) and what it withdrew; a consent is taken on an identity
 * of the contact that is verified on the channel, with the proof when the way of capture leaves one, and is withdrawn with a reason. A withdrawal is felt by the next message. The proof itself is not shown here: it stays with the consent.
 */
export default function ContactConsentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ConsentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ConsentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || (permissions.includes(READ_PERMISSION) && permissions.includes(CONTACT_READ_PERMISSION));
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const pages = useContacts(canRead);
  const contacts = (pages.data?.pages ?? []).flatMap((page) => page.items);
  const [chosen, setChosen] = useState('');
  const contact = contacts.find((candidate) => candidate.id === chosen);
  const consents = useConsents(contact?.id, canRead);
  const contactsState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data, isEmpty: () => contacts.length === 0 });
  const consentsState = useScreenState({ isLoading: consents.isLoading, error: consents.error, data: consents.data, isEmpty: (data: unknown) => (data as Consent[]).length === 0 });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.consent.page.title')}</h1>
          <p>{t('omni.consent.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('omni.consent.rule.text')}</p>
        {notice === undefined ? null : (
          <p className="callout" role="status" data-notice>
            {notice}
          </p>
        )}
        <StateBoundary state={canRead ? contactsState : 'denied'} onRetry={() => void pages.refetch()}>
          <div className="field">
            <label htmlFor="consent-contact">{t('omni.consent.contact.label')}</label>
            <select id="consent-contact" value={chosen} onChange={(event) => { setChosen(event.target.value); setNotice(undefined); }}>
              <option value="">{t('omni.consent.contact.none')}</option>
              {contacts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </div>
          {pages.hasNextPage ? (
            <button type="button" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
              {t('omni.consent.contact.more')}
            </button>
          ) : null}
          {contact === undefined ? (
            <p className="sub" role="status" data-choose>
              {t('omni.consent.contact.choose')}
            </p>
          ) : (
            <>
              <StateBoundary state={consentsState} onRetry={() => void consents.refetch()}>
                <table>
                  <caption className="sr-only">{t('omni.consent.page.title')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('omni.consent.col.channel')}</th>
                      <th scope="col">{t('omni.consent.col.purpose')}</th>
                      <th scope="col">{t('omni.consent.col.status')}</th>
                      <th scope="col">{t('omni.consent.col.version')}</th>
                      <th scope="col">{t('omni.consent.col.method')}</th>
                      <th scope="col">{t('omni.consent.col.since')}</th>
                      <th scope="col">{t('omni.consent.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(consents.data ?? []).map((consent) => (
                      <ConsentRow key={consent.id} consent={consent} canManage={canManage} onDone={() => setNotice(t('omni.consent.done.withdrawn'))} />
                    ))}
                  </tbody>
                </table>
              </StateBoundary>
              {canManage && takesConsent(contact) ? <GrantForm key={contact.id} contact={contact} onDone={() => setNotice(t('omni.consent.done.granted'))} /> : null}
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

function ConsentRow({ consent, canManage, onDone }: { consent: Consent; canManage: boolean; onDone(): void }) {
  const { t, locale } = useTranslation();
  const withdraw = useWithdrawConsent();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = withdraw.isError ? describeProblem(withdraw.error) : undefined;
  const run = (event: FormEvent): void => {
    event.preventDefault();
    if (withdraw.isPending) return;
    setInvalid(reasonProblem(reason));
    if (reasonProblem(reason)) return;
    withdraw.reset();
    // The version the consent was read at goes with the withdrawal: a consent that changed meanwhile is a conflict.
    withdraw.mutate({ consentId: consent.id, version: consent.version, reason: reason.trim() }, { onSuccess: () => { setAsking(false); setReason(''); onDone(); } });
  };
  return (
    <tr data-consent-id={consent.id} data-status={consent.status}>
      <td>{channelLabel(t, consent.channel)}</td>
      <td>{purposeLabel(t, consent.purpose)}</td>
      <td data-consent-status>
        {statusLabel(t, consent.status)}
        {consent.revokedAt === undefined ? null : <small data-revoked> · {instantText(locale, consent.revokedAt)}</small>}
      </td>
      <td data-version>{consent.textVersion}</td>
      <td data-method>{methodLabel(t, consent.captureMethod)}</td>
      <td>{instantText(locale, consent.effectiveAt)}</td>
      <td>
        {canManage && consent.status === 'Granted' ? (
          <>
            <button type="button" onClick={() => setAsking(!asking)} aria-label={t('omni.consent.withdraw.aria', { channel: channelLabel(t, consent.channel), purpose: purposeLabel(t, consent.purpose) })}>
              {t('omni.consent.withdraw.action')}
            </button>
            {asking ? (
              <form onSubmit={run} noValidate aria-label={t('omni.consent.withdraw.form.aria', { channel: channelLabel(t, consent.channel), purpose: purposeLabel(t, consent.purpose) })} data-withdraw-form>
                {problem === undefined ? null : (
                  <p className="callout warning" role="alert" data-problem>
                    {problemMessage(t, problem)}
                  </p>
                )}
                {invalid ? (
                  <p className="callout warning" role="alert" data-reason-problem>
                    {t('omni.consent.withdraw.reason.invalid')}
                  </p>
                ) : null}
                <label htmlFor={`withdraw-reason-${consent.id}`}>{t('omni.consent.withdraw.reason.label')}</label>
                <textarea id={`withdraw-reason-${consent.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
                <button type="submit" className="primary" disabled={withdraw.isPending}>
                  {t('omni.consent.withdraw.confirm.action')}
                </button>
              </form>
            ) : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}

function GrantForm({ contact, onDone }: { contact: Contact; onDone(): void }) {
  const { t } = useTranslation();
  const grant = useGrantConsent();
  const channels = channelsOf(contact);
  const [form, setForm] = useState<ConsentForm>(() => emptyForm(channels[0] ?? ''));
  const [shown, setShown] = useState<readonly ReturnType<typeof consentProblems>[number][]>([]);
  const problem = grant.isError ? describeProblem(grant.error) : undefined;
  const update = (change: Partial<ConsentForm>): void => setForm((current) => ({ ...current, ...change }));
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (grant.isPending) return;
    const found = consentProblems(form);
    setShown(found);
    if (found.length > 0) return;
    grant.reset();
    grant.mutate({ contactId: contact.id, body: consentBody(form) }, { onSuccess: () => { setForm(emptyForm(channels[0] ?? '')); onDone(); } });
  };
  return (
    <form onSubmit={save} noValidate aria-label={t('omni.consent.form.aria', { name: contact.displayName })} className="card" data-consent-form>
      <h2>{t('omni.consent.form.title')}</h2>
      {channels.length === 0 ? (
        <p className="sub" role="status" data-no-channel>
          {t('omni.consent.form.noChannel')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem)}
        </p>
      )}
      {shown.map((item) => (
        <p key={item} className="callout warning" role="alert" data-form-problem={item}>
          {formProblemMessage(t, item)}
        </p>
      ))}
      <div className="field">
        <label htmlFor="consent-channel">{t('omni.consent.form.channel.label')}</label>
        <select id="consent-channel" value={form.channel} onChange={(event) => update({ channel: event.target.value as ConsentForm['channel'] })}>
          {channels.length === 0 ? <option value="">{t('omni.consent.form.channel.none')}</option> : null}
          {CHANNELS.filter((channel) => channels.includes(channel)).map((channel) => (
            <option key={channel} value={channel}>
              {channelLabel(t, channel)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="consent-purpose">{t('omni.consent.form.purpose.label')}</label>
        <select id="consent-purpose" value={form.purpose} onChange={(event) => update({ purpose: event.target.value as ConsentForm['purpose'] })}>
          {PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {purposeLabel(t, purpose)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="consent-version">{t('omni.consent.form.version.label')}</label>
        <input id="consent-version" value={form.textVersion} onChange={(event) => update({ textVersion: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="consent-method">{t('omni.consent.form.method.label')}</label>
        <select id="consent-method" value={form.method} onChange={(event) => update({ method: event.target.value as ConsentForm['method'] })}>
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {methodLabel(t, method)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="consent-evidence">{needsEvidence(form.method) ? t('omni.consent.form.evidence.required') : t('omni.consent.form.evidence.label')}</label>
        <input id="consent-evidence" value={form.evidence} onChange={(event) => update({ evidence: event.target.value })} />
      </div>
      <button type="submit" className="primary" disabled={grant.isPending || channels.length === 0}>
        {t('omni.consent.form.submit.action')}
      </button>
    </form>
  );
}
