import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../dgv.css';
import { useDraftRubric, usePublishRubric, useRubrics } from './hooks';
import { pillarLabel, problemMessage, rubricStatusLabel } from './labels';
import { EMPTY_RUBRIC, MANAGE_PERMISSION, PUBLISH_PERMISSION, describeMaturityProblem, personName, rubricTemplate, validateRubric } from './model';
import type { FormProblem, Rubric, RubricField, RubricForm } from './model';
import '../dgv-kit.css';
import { StatusPill } from '../../../ui';
import { pillTone } from '../pill-tone';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));

/**
 * DGV-21: the rubric of maturity (ST-DGV-008, DGV 3.1 F8, UAT-AC493): its versions, and for the one chosen the pillars with their weights, the criteria with the description of each level 1 to 5, the references to the frameworks
 * (a mapping, not a certification), the share of criteria that must be assessed for a total and the days evidence lasts; the form to draft the next version and the button that publishes a draft (not by who drafted it).
 */
export default function RubricScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <RubricContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RubricContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const rubrics = useRubrics();
  const [chosen, setChosen] = useState('');
  const state = useScreenState({ isLoading: rubrics.isLoading, error: rubrics.error, data: rubrics.data, isEmpty: () => false });
  const list = rubrics.data ?? [];
  const selected = list.find((rubric) => rubric.id === chosen) ?? list.find((rubric) => rubric.status === 'PUBLISHED') ?? list[0];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.maturity.rubric.title')}</h1>
          <p>{t('dgv.maturity.rubric.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void rubrics.refetch()}>
        {selected === undefined ? (
          <p className="card" data-testid="no-rubric">
            {t('dgv.maturity.rubric.none')}
          </p>
        ) : (
          <>
            <Field id="rubric-version" label={t('dgv.maturity.rubric.version')} error={undefined}>
              <select id="rubric-version" value={selected.id} onChange={(event) => setChosen(event.target.value)}>
                {list.map((rubric) => (
                  <option key={rubric.id} value={rubric.id}>
                    {t('dgv.maturity.rubric.option', { code: rubric.code, revision: rubric.revision, status: rubricStatusLabel(t, rubric.status) })}
                  </option>
                ))}
              </select>
            </Field>
            <RubricView key={selected.id} rubric={selected} mayPublish={holds(permissions, PUBLISH_PERMISSION, mode)} />
          </>
        )}
        {holds(permissions, MANAGE_PERMISSION, mode) ? <DraftPanel /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('dgv.maturity.rubric.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RubricView({ rubric, mayPublish }: { rubric: Rubric; mayPublish: boolean }) {
  const { t } = useTranslation();
  const publish = usePublishRubric();
  const failure = publish.isError ? describeMaturityProblem(publish.error) : undefined;
  return (
    <section className="card" aria-labelledby="rubric-title" data-rubric={rubric.id} data-status={rubric.status}>
      <h2 id="rubric-title">{t('dgv.maturity.rubric.heading', { code: rubric.code, revision: rubric.revision })}</h2>
      <dl>
        <div>
          <dt>{t('dgv.maturity.rubric.status')}</dt>
          <dd>
            <StatusPill tone={pillTone(rubric.status === 'PUBLISHED' ? 'green' : 'gray')}>{rubricStatusLabel(t, rubric.status)}</StatusPill>
          </dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.rubric.minCoverage')}</dt>
          <dd data-testid="min-coverage">{rubric.minCoveragePct}%</dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.rubric.ttl')}</dt>
          <dd data-testid="ttl">{t('dgv.maturity.rubric.days', { days: rubric.evidenceTtlDays })}</dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.rubric.approved')}</dt>
          <dd>{personName(rubric.approvedBy)}</dd>
        </div>
      </dl>
      <h3>{t('dgv.maturity.rubric.frameworks')}</h3>
      <p className="sub" data-testid="frameworks-note">
        {t('dgv.maturity.rubric.frameworks.note')}
      </p>
      <ul>
        {Object.entries(rubric.frameworkRefs).map(([name, places]) => (
          <li key={name}>
            <strong>{name}</strong> {places.join(', ')}
          </li>
        ))}
      </ul>
      <div className="tablewrap">
        <table className="table" data-testid="rubric-table" aria-label={t('dgv.maturity.rubric.table')}>
          <thead>
            <tr>
              <th scope="col">{t('dgv.maturity.col.pillar')}</th>
              <th scope="col">{t('dgv.maturity.col.criterion')}</th>
              <th scope="col">{t('dgv.maturity.col.weight')}</th>
              {[1, 2, 3, 4, 5].map((level) => (
                <th key={level} scope="col">
                  {t('dgv.maturity.col.level', { level })}
                </th>
              ))}
              <th scope="col">{t('dgv.maturity.col.frameworkRefs')}</th>
            </tr>
          </thead>
          <tbody>
            {rubric.pillars.flatMap((pillar) => [
              <tr key={pillar.code} data-pillar={pillar.code}>
                <th scope="rowgroup" colSpan={9}>
                  {pillarLabel(t, pillar.code)} · {t('dgv.maturity.col.weight')} {pillar.weight}
                </th>
              </tr>,
              ...pillar.criteria.map((criterion) => (
                <tr key={`${pillar.code}:${criterion.code}`} data-criterion={criterion.code}>
                  <td />
                  <td>
                    <code>{criterion.code}</code> {criterion.name}
                  </td>
                  <td>{criterion.weight}</td>
                  {['1', '2', '3', '4', '5'].map((level) => (
                    <td key={level}>{criterion.levels[level] ?? ''}</td>
                  ))}
                  <td>{criterion.refs.join(', ')}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {mayPublish && rubric.status === 'DRAFT' ? (
        <div className="formfooter">
          <button type="button" className="ui-button ui-button--primary" disabled={publish.isPending} onClick={() => publish.mutate({ id: rubric.id, version: rubric.version })}>
            {t('dgv.maturity.rubric.publish')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DraftPanel() {
  const { t } = useTranslation();
  const send = useDraftRubric();
  const [form, setForm] = useState<RubricForm>(EMPTY_RUBRIC);
  const [problems, setProblems] = useState<Partial<Record<RubricField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const set = (patch: Partial<RubricForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('dgv.maturity.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateRubric(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setForm(EMPTY_RUBRIC);
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.maturity.draft.title')}>
      <h2>{t('dgv.maturity.draft.title')}</h2>
      <Field id="rubric-code" label={t('dgv.maturity.draft.code')} hint={t('dgv.maturity.draft.code.hint')} error={message(problems.code, t('dgv.maturity.draft.code.invalid'))}>
        <input id="rubric-code" value={form.code} aria-invalid={problems.code !== undefined} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field id="rubric-coverage" label={t('dgv.maturity.draft.minCoverage')} error={message(problems.minCoveragePct, t('dgv.maturity.draft.coverage.invalid'))}>
        <input id="rubric-coverage" value={form.minCoveragePct} aria-invalid={problems.minCoveragePct !== undefined} onChange={(event) => set({ minCoveragePct: event.target.value })} />
      </Field>
      <Field id="rubric-days" label={t('dgv.maturity.draft.days')} error={message(problems.evidenceTtlDays, t('dgv.maturity.draft.days.invalid'))}>
        <input id="rubric-days" value={form.evidenceTtlDays} aria-invalid={problems.evidenceTtlDays !== undefined} onChange={(event) => set({ evidenceTtlDays: event.target.value })} />
      </Field>
      <Field
        id="rubric-frameworks"
        label={t('dgv.maturity.draft.frameworkMap')}
        hint={t('dgv.maturity.draft.frameworks.hint')}
        error={message(problems.frameworkRefs, t('dgv.maturity.draft.json.invalid'))}
      >
        <textarea id="rubric-frameworks" rows={3} value={form.frameworkRefs} aria-invalid={problems.frameworkRefs !== undefined} onChange={(event) => set({ frameworkRefs: event.target.value })} />
      </Field>
      <Field id="rubric-pillars" label={t('dgv.maturity.draft.pillars')} hint={t('dgv.maturity.draft.pillars.hint')} error={message(problems.pillars, t('dgv.maturity.draft.json.invalid'))}>
        <textarea id="rubric-pillars" rows={10} value={form.pillars} aria-invalid={problems.pillars !== undefined} onChange={(event) => set({ pillars: event.target.value })} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="draft-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="draft-saved">
          {t('dgv.maturity.draft.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="button" onClick={() => set({ frameworkRefs: rubricTemplate().frameworkRefs, pillars: rubricTemplate().pillars })}>
          {t('dgv.maturity.draft.template')}
        </button>
        <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
          {t('dgv.maturity.draft.submit')}
        </button>
      </div>
    </form>
  );
}
