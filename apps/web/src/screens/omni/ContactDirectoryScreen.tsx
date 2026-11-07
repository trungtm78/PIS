import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import '../not/delivery/delivery.css';
import { useAddIdentity, useContacts, useCreateContact, useMergeContacts, useVerifyIdentity } from './contact/hooks';
import { channelLabel, classificationLabel, contactStatusLabel, identityStatusLabel, methodLabel, problemMessage } from './contact/labels';
import {
  CLASSIFICATIONS,
  IDENTITY_CHANNELS,
  MANAGE_PERMISSION,
  MERGE_PERMISSION,
  READ_PERMISSION,
  contactBody,
  contactProblems,
  describeProblem,
  emptyContactForm,
  emptyIdentityForm,
  emptyVerifyForm,
  identityProblem,
  mayMerge,
  methodsFor,
  reasonProblem,
  verifyBody,
  verifyProblems,
} from './contact/model';
import type { Contact, ContactForm, Identity, IdentityForm, VerifyForm } from './contact/model';
import { StatusPill } from '../../ui';

/**
 * OMNI-03: the directory of the people outside the tenant that write to it. A contact has identities (a phone number, an address, a Zalo or WhatsApp id) that are shown masked; an identity is verified by a code sent to it, by the provider that
 * authenticates the sender, or, for a supervisor, by a document. Two contacts are merged only on a verified identity they share: the merge is offered for those, and for no others, whatever their names.
 */
export default function ContactDirectoryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <ContactDirectoryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContactDirectoryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const writable = mode !== 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && writable;
  const canMerge = (permissions === undefined || permissions.includes(MERGE_PERMISSION)) && writable;
  const pages = useContacts(canRead);
  const contacts = (pages.data?.pages ?? []).flatMap((page) => page.items);
  const queryState = useScreenState({ isLoading: pages.isLoading, error: pages.error, data: pages.data, isEmpty: () => contacts.length === 0 });
  const state = canRead ? queryState : 'denied';
  const [notice, setNotice] = useState<string | undefined>(undefined);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.contact.page.title')}</h1>
          <p>{t('omni.contact.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('omni.contact.rule.text')}</p>
        {notice === undefined ? null : (
          <p className="callout" role="status" data-notice>
            {notice}
          </p>
        )}
        {canManage ? <CreateForm onDone={() => setNotice(t('omni.contact.done.created'))} /> : null}
        <StateBoundary state={state} onRetry={() => void pages.refetch()}>
          <ul data-contacts>
            {contacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} canManage={canManage} canMerge={canMerge} names={contacts} onNotice={setNotice} />
            ))}
          </ul>
          {pages.hasNextPage ? (
            <button type="button" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
              {t('omni.contact.list.more')}
            </button>
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}

function CreateForm({ onDone }: { onDone(): void }) {
  const { t, locale } = useTranslation();
  const create = useCreateContact();
  const [form, setForm] = useState<ContactForm>(emptyContactForm);
  const [invalid, setInvalid] = useState(false);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = contactProblems(form).length > 0;
    setInvalid(found);
    if (found) return;
    create.reset();
    create.mutate(contactBody(form), {
      onSuccess: () => {
        setForm(emptyContactForm());
        onDone();
      },
    });
  };
  return (
    <form onSubmit={save} noValidate aria-label={t('omni.contact.form.aria')} className="card" data-contact-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem, locale)}
        </p>
      )}
      {invalid ? (
        <p className="callout warning" role="alert" data-form-problem="name">
          {t('omni.contact.form.name.invalid')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="contact-name">{t('omni.contact.form.name.label')}</label>
        <input id="contact-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="contact-class">{t('omni.contact.form.class.label')}</label>
        <select id="contact-class" value={form.classification} onChange={(event) => setForm({ ...form, classification: event.target.value as ContactForm['classification'] })}>
          {CLASSIFICATIONS.map((value) => (
            <option key={value} value={value}>
              {classificationLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="contact-preferred">{t('omni.contact.form.preferred.label')}</label>
        <select id="contact-preferred" value={form.preferredChannel} onChange={(event) => setForm({ ...form, preferredChannel: event.target.value as ContactForm['preferredChannel'] })}>
          <option value="">{t('omni.contact.form.preferred.none')}</option>
          {IDENTITY_CHANNELS.map((value) => (
            <option key={value} value={value}>
              {channelLabel(t, value)}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
        {t('omni.contact.form.submit.action')}
      </button>
    </form>
  );
}

function ContactCard({ contact, canManage, canMerge, names, onNotice }: { contact: Contact; canManage: boolean; canMerge: boolean; names: readonly Contact[]; onNotice(text: string): void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const live = contact.status === 'Unverified' || contact.status === 'Verified';
  const into = contact.mergedIntoId === undefined ? undefined : names.find((candidate) => candidate.id === contact.mergedIntoId);
  return (
    <li data-contact-id={contact.id} data-status={contact.status}>
      <strong>{contact.displayName}</strong> · {classificationLabel(t, contact.classification)} ·{' '}
      <span data-contact-status>
        <StatusPill tone={contact.status === 'Verified' ? 'success' : contact.status === 'Unverified' ? 'warning' : 'neutral'}>{contactStatusLabel(t, contact.status)}</StatusPill>
      </span>
      {contact.status === 'Merged' ? <span data-merged-into> · {t('omni.contact.merged.into', { name: into?.displayName ?? contact.mergedIntoId ?? '' })}</span> : null}
      <ul data-identities>
        {contact.identities.map((identity) => (
          <IdentityRow key={identity.id} identity={identity} contact={contact} canManage={canManage && live} canMerge={canMerge} onNotice={onNotice} />
        ))}
      </ul>
      {canManage && live ? (
        <>
          <button type="button" onClick={() => setAdding(!adding)}>
            {t('omni.contact.add.action')}
          </button>
          {adding ? <AddIdentityForm contact={contact} onDone={() => { setAdding(false); onNotice(t('omni.contact.done.added')); }} /> : null}
        </>
      ) : null}
      {canMerge && live ? <MergeSection contact={contact} onDone={() => onNotice(t('omni.contact.done.merged'))} /> : null}
    </li>
  );
}

function AddIdentityForm({ contact, onDone }: { contact: Contact; onDone(): void }) {
  const { t, locale } = useTranslation();
  const add = useAddIdentity();
  const [form, setForm] = useState<IdentityForm>(emptyIdentityForm);
  const [invalid, setInvalid] = useState(false);
  const problem = add.isError ? describeProblem(add.error) : undefined;
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (add.isPending) return;
    setInvalid(identityProblem(form));
    if (identityProblem(form)) return;
    add.reset();
    add.mutate({ contactId: contact.id, channel: form.channel, externalId: form.value.trim() }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={save} noValidate aria-label={t('omni.contact.add.form.aria', { name: contact.displayName })} data-identity-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem, locale)}
        </p>
      )}
      {invalid ? (
        <p className="callout warning" role="alert" data-form-problem="value">
          {t('omni.contact.add.value.invalid')}
        </p>
      ) : null}
      <label htmlFor={`identity-channel-${contact.id}`}>{t('omni.contact.add.channel.label')}</label>
      <select id={`identity-channel-${contact.id}`} value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as IdentityForm['channel'] })}>
        {IDENTITY_CHANNELS.map((value) => (
          <option key={value} value={value}>
            {channelLabel(t, value)}
          </option>
        ))}
      </select>
      <label htmlFor={`identity-value-${contact.id}`}>{t('omni.contact.add.value.label')}</label>
      <input id={`identity-value-${contact.id}`} value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} />
      <button type="submit" className="primary" disabled={add.isPending}>
        {t('omni.contact.add.submit.action')}
      </button>
    </form>
  );
}

function IdentityRow({ identity, contact, canManage, canMerge, onNotice }: { identity: Identity; contact: Contact; canManage: boolean; canMerge: boolean; onNotice(text: string): void }) {
  const { t, locale } = useTranslation();
  const [verifying, setVerifying] = useState(false);
  return (
    <li data-identity-id={identity.id} data-identity-status={identity.status}>
      <span data-masked>{identity.masked}</span> · {channelLabel(t, identity.channel)} · {identityStatusLabel(t, identity.status)}
      {identity.method === undefined ? null : <span data-method> · {methodLabel(t, identity.method)}</span>}
      {identity.verifiedAt === undefined ? null : <span> · {instantText(locale, identity.verifiedAt)}</span>}
      {identity.contactId !== contact.id ? <span data-inherited> · {t('omni.contact.identity.inherited')}</span> : null}
      {canManage && identity.status === 'Pending' && methodsFor(identity.channel, canMerge).length > 0 ? (
        <>
          {' '}
          <button type="button" onClick={() => setVerifying(!verifying)} aria-label={t('omni.contact.verify.aria', { masked: identity.masked })}>
            {t('omni.contact.verify.action')}
          </button>
          {verifying ? <VerifyForm identity={identity} contact={contact} canMerge={canMerge} onDone={() => { setVerifying(false); onNotice(t('omni.contact.done.verified')); }} /> : null}
        </>
      ) : null}
    </li>
  );
}

function VerifyForm({ identity, contact, canMerge, onDone }: { identity: Identity; contact: Contact; canMerge: boolean; onDone(): void }) {
  const { t, locale } = useTranslation();
  const verify = useVerifyIdentity();
  const methods = methodsFor(identity.channel, canMerge);
  const [form, setForm] = useState<VerifyForm>(() => emptyVerifyForm(methods[0] ?? 'OTP'));
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const problem = verify.isError ? describeProblem(verify.error) : undefined;
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (verify.isPending) return;
    const found = verifyProblems(form)[0];
    setInvalid(found);
    if (found !== undefined) return;
    verify.reset();
    // The version the identity was read at goes with the verification: a code sent again since is a conflict and not overwritten.
    verify.mutate({ contactId: contact.id, identityId: identity.id, version: identity.version, body: verifyBody(form) }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={save} noValidate aria-label={t('omni.contact.verify.form.aria', { masked: identity.masked })} data-verify-form>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem, locale)}
        </p>
      )}
      {invalid === 'otp' ? (
        <p className="callout warning" role="alert" data-form-problem="otp">
          {t('omni.contact.verify.otp.invalid')}
        </p>
      ) : null}
      {invalid === 'document' ? (
        <p className="callout warning" role="alert" data-form-problem="document">
          {t('omni.contact.verify.document.invalid')}
        </p>
      ) : null}
      <label htmlFor={`verify-method-${identity.id}`}>{t('omni.contact.verify.method.label')}</label>
      <select id={`verify-method-${identity.id}`} value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as VerifyForm['method'] })}>
        {methods.map((value) => (
          <option key={value} value={value}>
            {methodLabel(t, value)}
          </option>
        ))}
      </select>
      {form.method === 'OTP' ? (
        <>
          <label htmlFor={`verify-otp-${identity.id}`}>{t('omni.contact.verify.otp.label')}</label>
          <input id={`verify-otp-${identity.id}`} inputMode="numeric" autoComplete="one-time-code" value={form.otp} onChange={(event) => setForm({ ...form, otp: event.target.value.trim() })} />
        </>
      ) : null}
      {form.method === 'ADMIN_DOCUMENT' ? (
        <>
          <label htmlFor={`verify-document-${identity.id}`}>{t('omni.contact.verify.document.label')}</label>
          <input id={`verify-document-${identity.id}`} value={form.documentRef} onChange={(event) => setForm({ ...form, documentRef: event.target.value })} />
        </>
      ) : null}
      <button type="submit" className="primary" disabled={verify.isPending}>
        {t('omni.contact.verify.submit.action')}
      </button>
    </form>
  );
}

function MergeSection({ contact, onDone }: { contact: Contact; onDone(): void }) {
  const { t, locale } = useTranslation();
  const merge = useMergeContacts();
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = merge.isError ? describeProblem(merge.error) : undefined;
  const offered = mayMerge(contact, true);
  const candidate = contact.mergeCandidates.find((item) => item.contactId === target);
  const run = (event: FormEvent): void => {
    event.preventDefault();
    if (merge.isPending || candidate === undefined) return;
    setInvalid(reasonProblem(reason));
    if (reasonProblem(reason)) return;
    merge.reset();
    merge.mutate({ survivorId: contact.id, mergedId: candidate.contactId, identityId: candidate.identityId, reason: reason.trim() }, { onSuccess: () => { setTarget(undefined); setReason(''); onDone(); } });
  };
  return (
    <div data-merge>
      {offered ? (
        <ul data-merge-candidates>
          {contact.mergeCandidates.map((item) => (
            <li key={item.contactId}>
              {item.displayName}{' '}
              <button type="button" data-merge-button onClick={() => setTarget(target === item.contactId ? undefined : item.contactId)} aria-label={t('omni.contact.merge.action.aria', { name: item.displayName })}>
                {t('omni.contact.merge.action')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <button type="button" data-merge-button disabled aria-describedby={`merge-none-${contact.id}`}>
            {t('omni.contact.merge.action')}
          </button>{' '}
          <small id={`merge-none-${contact.id}`} data-merge-none>
            {t('omni.contact.merge.none')}
          </small>
        </>
      )}
      {candidate === undefined ? null : (
        <form onSubmit={run} noValidate aria-label={t('omni.contact.merge.form.aria', { name: candidate.displayName })} data-merge-form>
          {problem === undefined ? null : (
            <p className="callout warning" role="alert" data-problem>
              {problemMessage(t, problem, locale)}
            </p>
          )}
          {invalid ? (
            <p className="callout warning" role="alert" data-form-problem="reason">
              {t('omni.contact.merge.reason.invalid')}
            </p>
          ) : null}
          <p className="sub">{t('omni.contact.merge.rule', { name: candidate.displayName })}</p>
          <label htmlFor={`merge-reason-${contact.id}`}>{t('omni.contact.merge.reason.label')}</label>
          <textarea id={`merge-reason-${contact.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
          <button type="submit" className="primary" disabled={merge.isPending}>
            {t('omni.contact.merge.confirm.action')}
          </button>
        </form>
      )}
    </div>
  );
}
