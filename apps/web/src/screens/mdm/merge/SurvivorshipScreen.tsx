import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../mdm.css';
import { useDraftRule, usePublishRule, useRules } from './hooks';
import { problemMessage, ruleStatusLabel, strategyLabel } from './labels';
import { EMPTY_RULE, RULE_APPROVE_PERMISSION, RULE_MANAGE_PERMISSION, STRATEGIES, addSource, describeMergeProblem, moveSource, usesSources, validateRule } from './model';
import type { FormProblem, Rule, RuleField, RuleForm } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));

/**
 * MDM-36: the rules of survivorship (ST-MDM-010, MDM 3.1 F5, BR-MDM-05): for each attribute of a type, which record wins when two are merged - the source with the higher place in an order, the later record, the more
 * complete one, or a steward's decision. A rule is drafted by one person and published by another; a new revision replaces the one before it. The order of the sources is set with the keys, one place at a time.
 */
export default function SurvivorshipScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <SurvivorshipContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SurvivorshipContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const rules = useRules();
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.error, data: rules.data, isEmpty: () => false });
  const list = rules.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.merge.rules.title')}</h1>
          <p>{t('mdm.merge.rules.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void rules.refetch()}>
        {list.length === 0 ? (
          <p className="card" data-testid="no-rules">
            {t('mdm.merge.rules.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="rules" aria-label={t('mdm.merge.rules.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('mdm.merge.col.type')}</th>
                  <th scope="col">{t('mdm.merge.col.attribute')}</th>
                  <th scope="col">{t('mdm.merge.col.strategy')}</th>
                  <th scope="col">{t('mdm.merge.col.sources')}</th>
                  <th scope="col">{t('mdm.merge.col.revision')}</th>
                  <th scope="col">{t('mdm.merge.col.status')}</th>
                  <th scope="col">{t('mdm.merge.col.effective')}</th>
                  <th scope="col">{t('mdm.merge.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} mayPublish={holds(permissions, RULE_APPROVE_PERMISSION, mode)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {holds(permissions, RULE_MANAGE_PERMISSION, mode) ? <DraftPanel /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.merge.rules.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RuleRow({ rule, mayPublish }: { rule: Rule; mayPublish: boolean }) {
  const { t } = useTranslation();
  const publish = usePublishRule();
  const failure = publish.isError ? describeMergeProblem(publish.error) : undefined;
  return (
    <tr data-rule={rule.id} data-status={rule.status}>
      <td>{rule.masterType}</td>
      <td>
        <code>{rule.attribute}</code>
      </td>
      <td>{strategyLabel(t, rule.strategy)}</td>
      <td>{rule.sources.length === 0 ? '—' : rule.sources.map((source, index) => `${index + 1}. ${source}`).join(' › ')}</td>
      <td>{rule.revision}</td>
      <td>
        <span className={`pill ${rule.status === 'PUBLISHED' ? 'green' : 'gray'}`}>{ruleStatusLabel(t, rule.status)}</span>
      </td>
      <td>{rule.effectiveFrom}</td>
      <td>
        {mayPublish && rule.status === 'DRAFT' ? (
          <button type="button" className="primary" disabled={publish.isPending} onClick={() => publish.mutate({ id: rule.id, version: rule.version })}>
            {t('mdm.merge.rule.publish', { attribute: rule.attribute })}
          </button>
        ) : null}
        {failure === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="publish-refusal" data-reason={failure.reason}>
            {problemMessage(t, failure)}
          </p>
        )}
      </td>
    </tr>
  );
}

function DraftPanel() {
  const { t } = useTranslation();
  const send = useDraftRule();
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE);
  const [source, setSource] = useState('');
  const [problems, setProblems] = useState<Partial<Record<RuleField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeMergeProblem(send.error) : undefined;
  const set = (patch: Partial<RuleForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('mdm.merge.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateRule(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setForm(EMPTY_RULE);
        setSource('');
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('mdm.merge.draft.title')}>
      <h2>{t('mdm.merge.draft.title')}</h2>
      <Field id="rule-type" label={t('mdm.merge.col.type')} error={message(problems.masterType, t('mdm.merge.draft.type.invalid'))}>
        <input id="rule-type" value={form.masterType} aria-invalid={problems.masterType !== undefined} onChange={(event) => set({ masterType: event.target.value })} />
      </Field>
      <Field id="rule-attribute" label={t('mdm.merge.col.attribute')} hint={t('mdm.merge.draft.attribute.hint')} error={message(problems.attribute, t('mdm.merge.draft.attribute.invalid'))}>
        <input id="rule-attribute" value={form.attribute} aria-invalid={problems.attribute !== undefined} onChange={(event) => set({ attribute: event.target.value })} />
      </Field>
      <Field id="rule-strategy" label={t('mdm.merge.col.strategy')} error={undefined}>
        <select
          id="rule-strategy"
          value={form.strategy}
          onChange={(event) => set({ strategy: event.target.value as RuleForm['strategy'], sources: usesSources(event.target.value as RuleForm['strategy']) ? form.sources : [] })}
        >
          {STRATEGIES.map((strategy) => (
            <option key={strategy} value={strategy}>
              {strategyLabel(t, strategy)}
            </option>
          ))}
        </select>
      </Field>
      {usesSources(form.strategy) ? (
        <fieldset>
          <legend>{t('mdm.merge.draft.sources')}</legend>
          <p className="sub">{t('mdm.merge.draft.sources.hint')}</p>
          <ol data-testid="sources">
            {form.sources.map((name, index) => (
              <li key={name} data-source={name}>
                <span>{name}</span>
                <button type="button" disabled={index === 0} onClick={() => set({ sources: moveSource(form.sources, index, -1) })}>
                  {t('mdm.merge.draft.up', { source: name })}
                </button>
                <button type="button" disabled={index === form.sources.length - 1} onClick={() => set({ sources: moveSource(form.sources, index, 1) })}>
                  {t('mdm.merge.draft.down', { source: name })}
                </button>
                <button type="button" onClick={() => set({ sources: form.sources.filter((item) => item !== name) })}>
                  {t('mdm.merge.draft.remove', { source: name })}
                </button>
              </li>
            ))}
          </ol>
          <Field id="rule-source" label={t('mdm.merge.draft.source')} error={message(problems.sources, t('mdm.merge.draft.sources.invalid'))}>
            <input id="rule-source" value={source} aria-invalid={problems.sources !== undefined} onChange={(event) => setSource(event.target.value)} />
          </Field>
          <button
            type="button"
            onClick={() => {
              set({ sources: addSource(form.sources, source) });
              setSource('');
            }}
          >
            {t('mdm.merge.draft.add')}
          </button>
        </fieldset>
      ) : null}
      <Field id="rule-effective" label={t('mdm.merge.col.effective')} error={message(problems.effectiveFrom, t('mdm.merge.draft.effective.invalid'))}>
        <input id="rule-effective" type="date" value={form.effectiveFrom} aria-invalid={problems.effectiveFrom !== undefined} onChange={(event) => set({ effectiveFrom: event.target.value })} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="draft-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="draft-saved">
          {t('mdm.merge.draft.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('mdm.merge.draft.submit')}
        </button>
      </div>
    </form>
  );
}
