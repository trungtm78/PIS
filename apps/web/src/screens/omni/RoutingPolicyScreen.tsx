import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { instantText } from '../adm/audit/SealBanner';
import '../not/delivery/delivery.css';
import { useCreatePolicy, usePolicies, usePublishPolicy } from './policy/hooks';
import { channelLabel, policyProblemMessage, priorityLabel, problemMessage, statusLabel, statusPill } from './policy/labels';
import { CHANNELS, MANAGE_PERMISSION, PRIORITIES, describeProblem, emptyPolicy, emptyRule, policyBody, policyProblems, reasonProblem } from './policy/model';
import type { Policy, PolicyForm, PolicyProblem, Priority, RuleForm, UnitOption } from './policy/model';

/**
 * OMNI-07: assignment and SLA. The versions of the routing policy of the tenant: the rules that put a new conversation in the queue of a unit (by channel and by words, the first that fits), the minutes of working time for the first answer and the hours for
 * the resolution, counted on a working calendar. A version is written as a draft and published once, with a reason, at the version that was read; the one that was in force is replaced. Conversations that begin afterwards are routed by it.
 */
export default function RoutingPolicyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms belong to one membership: switching tenant starts the screen over, so nothing typed for one is sent to another.
  return <PolicyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PolicyContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(MANAGE_PERMISSION);
  const canWrite = canRead && mode !== 'READ_ONLY';
  const policies = usePolicies(canRead);
  const rows = (policies.data?.pages ?? []).flatMap((page) => page.items);
  // The units a rule may name come with the policies: whoever manages them needs no other permission to choose a queue.
  const units = policies.data?.pages[0]?.units ?? [];
  const state = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data, isEmpty: () => rows.length === 0 });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const unitName = (id: string): string => units.find((unit) => unit.id === id)?.name ?? id;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('omni.policy.page.title')}</h1>
          <p>{t('omni.policy.page.subtitle')}</p>
        </div>
      </div>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-notice>
          {notice}
        </p>
      )}
      <div className="card">
        <StateBoundary state={canRead ? state : 'denied'} onRetry={() => void policies.refetch()}>
          <table>
            <caption className="sr-only">{t('omni.policy.page.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('omni.policy.col.revision')}</th>
                <th scope="col">{t('omni.policy.col.status')}</th>
                <th scope="col">{t('omni.policy.col.rules')}</th>
                <th scope="col">{t('omni.policy.col.first')}</th>
                <th scope="col">{t('omni.policy.col.resolution')}</th>
                <th scope="col">{t('omni.policy.col.calendar')}</th>
                <th scope="col">{t('omni.policy.col.published')}</th>
                <th scope="col">{t('omni.policy.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} unitName={unitName} canWrite={canWrite} locale={locale} onDone={setNotice} />
              ))}
            </tbody>
          </table>
          {policies.hasNextPage ? (
            <button type="button" onClick={() => void policies.fetchNextPage()} disabled={policies.isFetchingNextPage}>
              {t('omni.policy.more.action')}
            </button>
          ) : null}
        </StateBoundary>
      </div>
      {canWrite ? <PolicyFormCard units={units} onDone={() => setNotice(t('omni.policy.done.created'))} /> : null}
    </section>
  );
}

function PolicyRow({ policy, unitName, canWrite, locale, onDone }: { policy: Policy; unitName(id: string): string; canWrite: boolean; locale: string; onDone(notice: string): void }) {
  const { t } = useTranslation();
  const publish = usePublishPolicy();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const problem = publish.isError ? describeProblem(publish.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (publish.isPending) return;
    setInvalid(reasonProblem(reason));
    if (reasonProblem(reason)) return;
    publish.reset();
    // The version the policy was read at goes with the publication: a policy that changed meanwhile is a conflict.
    publish.mutate(
      { id: policy.id, version: policy.version, reason: reason.trim() },
      {
        onSuccess: () => {
          setAsking(false);
          setReason('');
          onDone(t('omni.policy.done.published', { revision: policy.revision }));
        },
      },
    );
  };
  return (
    <tr data-policy-id={policy.id} data-status={policy.status}>
      <td>{policy.revision}</td>
      <td>
        <span className={statusPill(policy.status)} data-policy-status>
          {statusLabel(t, policy.status)}
        </span>
      </td>
      <td data-rules>
        {policy.rules.length === 0 ? <span className="sub">{t('omni.policy.rules.none')}</span> : null}
        {policy.rules.map((rule, index) => (
          <div key={index} data-rule>
            {rule.channels.length === 0 ? t('omni.policy.rule.anyChannel') : rule.channels.map((channel) => channelLabel(t, channel)).join(', ')}
            {rule.keywords.length === 0 ? '' : ` · ${rule.keywords.join(', ')}`} → {unitName(rule.queueUnitId)} ({priorityLabel(t, rule.priority)})
          </div>
        ))}
      </td>
      <td data-first>{policy.firstResponseMinutes}</td>
      <td data-resolution>{policy.resolutionHours}</td>
      <td>{policy.calendarCode}</td>
      <td>{policy.publishedAt === undefined ? '' : instantText(locale, policy.publishedAt)}</td>
      <td>
        {canWrite && policy.status === 'Draft' ? (
          <>
            <button type="button" onClick={() => setAsking(!asking)} aria-label={t('omni.policy.publish.aria', { revision: policy.revision })}>
              {t('omni.policy.publish.action')}
            </button>
            {asking ? (
              <form onSubmit={submit} noValidate aria-label={t('omni.policy.publish.form.aria', { revision: policy.revision })} data-publish-form>
                {problem === undefined ? null : (
                  <p className="callout warning" role="alert" data-problem>
                    {problemMessage(t, problem, 'policy')}
                  </p>
                )}
                <label htmlFor={`publish-reason-${policy.id}`}>{t('omni.policy.publish.reason.label')}</label>
                <textarea id={`publish-reason-${policy.id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
                {invalid ? (
                  <small role="alert" className="field-error" data-reason-problem>
                    {t('omni.policy.publish.reason.invalid')}
                  </small>
                ) : null}
                <button type="submit" className="primary" disabled={publish.isPending}>
                  {t('omni.policy.publish.confirm.action')}
                </button>
              </form>
            ) : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}

function PolicyFormCard({ units, onDone }: { units: readonly UnitOption[]; onDone(): void }) {
  const { t } = useTranslation();
  const create = useCreatePolicy();
  const [form, setForm] = useState<PolicyForm>(emptyPolicy);
  const [shown, setShown] = useState<readonly PolicyProblem[]>([]);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const setRule = (index: number, change: Partial<RuleForm>): void => setForm((current) => ({ ...current, rules: current.rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)) }));
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = policyProblems(form);
    setShown(found);
    if (found.length > 0) return;
    create.reset();
    create.mutate(policyBody(form), {
      onSuccess: () => {
        setForm(emptyPolicy());
        onDone();
      },
    });
  };
  return (
    <form onSubmit={save} noValidate aria-label={t('omni.policy.form.aria')} className="card" data-policy-form>
      <h2>{t('omni.policy.form.title')}</h2>
      <p className="sub">{t('omni.policy.form.hint')}</p>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-problem>
          {problemMessage(t, problem, 'policy')}
        </p>
      )}
      {shown.map((item) => (
        <p key={item} className="callout warning" role="alert" data-form-problem={item}>
          {policyProblemMessage(t, item)}
        </p>
      ))}
      <div className="field">
        <label htmlFor="policy-calendar">{t('omni.policy.form.calendar.label')}</label>
        <input id="policy-calendar" value={form.calendarCode} onChange={(event) => setForm({ ...form, calendarCode: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="policy-first">{t('omni.policy.form.first.label')}</label>
        <input id="policy-first" inputMode="numeric" value={form.firstResponseMinutes} onChange={(event) => setForm({ ...form, firstResponseMinutes: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="policy-resolution">{t('omni.policy.form.resolution.label')}</label>
        <input id="policy-resolution" inputMode="numeric" value={form.resolutionHours} onChange={(event) => setForm({ ...form, resolutionHours: event.target.value })} />
      </div>
      <h3>{t('omni.policy.form.rules.title')}</h3>
      {form.rules.map((rule, index) => (
        <fieldset key={index} data-rule-form={index}>
          <legend>{t('omni.policy.form.rule.legend', { number: index + 1 })}</legend>
          <label htmlFor={`rule-channel-${index}`}>{t('omni.policy.rule.channel.label')}</label>
          <select id={`rule-channel-${index}`} value={rule.channel} onChange={(event) => setRule(index, { channel: event.target.value })}>
            <option value="">{t('omni.policy.rule.anyChannel')}</option>
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {channelLabel(t, channel)}
              </option>
            ))}
          </select>
          <label htmlFor={`rule-words-${index}`}>{t('omni.policy.rule.words.label')}</label>
          <input id={`rule-words-${index}`} value={rule.keywords} onChange={(event) => setRule(index, { keywords: event.target.value })} />
          <label htmlFor={`rule-unit-${index}`}>{t('omni.policy.rule.unit.label')}</label>
          <select id={`rule-unit-${index}`} value={rule.queueUnitId} onChange={(event) => setRule(index, { queueUnitId: event.target.value })}>
            <option value="">{t('omni.policy.rule.unit.choose')}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
          <label htmlFor={`rule-priority-${index}`}>{t('omni.policy.rule.priority.label')}</label>
          <select id={`rule-priority-${index}`} value={rule.priority} onChange={(event) => setRule(index, { priority: event.target.value as Priority })}>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabel(t, priority)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setForm({ ...form, rules: form.rules.filter((_, at) => at !== index) })}>
            {t('omni.policy.rule.remove.action')}
          </button>
        </fieldset>
      ))}
      <p>
        <button type="button" onClick={() => setForm({ ...form, rules: [...form.rules, emptyRule()] })}>
          {t('omni.policy.rule.add.action')}
        </button>
      </p>
      <button type="submit" className="primary" disabled={create.isPending}>
        {t('omni.policy.form.submit.action')}
      </button>
    </form>
  );
}
