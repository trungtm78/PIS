import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink } from '../components';
import { LIST_PATH } from '../model';
import { ProjectPicker } from './components';
import { useProjectOptions } from '../hooks';
import { useChain, useSetTiers } from './hooks';
import { formProblemMessage, problemMessage, stageLabel } from './labels';
import { TIER_COUNTS, chainLink, describeProblem, emptyTiers, stagesOf, tiersBody, validateTiers } from './model';
import type { Chain, TiersForm } from './model';
import '../ctr.css';
import { SectionCard } from '../../../ui';

/**
 * CTR-20: the number of tiers of the chain of changes of a project (ST-CTR-006, BR-CTR-07). The business owner sets it to one, two or three, as often as they like until the first
 * request of the project is raised; from then on it is locked, here and in the database, and the screen says which request locked it. The server judges the command again.
 */
export default function TiersScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The policy and its form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <TiersContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TiersContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('project');
  const chain = useChain(projectId);
  // Opened without a project, the screen takes the first one the caller may see; the picker stays to change it.
  const first = useProjectOptions().data?.[0]?.id;
  useEffect(() => {
    if (projectId === null && first !== undefined) setSearch({ project: first }, { replace: true });
  }, [projectId, first, setSearch]);
  const state = useScreenState({
    isLoading: chain.isLoading,
    error: chain.error,
    data: projectId === null ? null : chain.data,
    isEmpty: (data) => data === null || data === undefined,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.change.tiers.page.title')}</h1>
          <p>{t('ctr.change.tiers.page.subtitle')}</p>
        </div>
      </div>
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      <ProjectPicker onPick={(id) => setSearch({ project: id })} />
      {projectId === null ? null : (
        <StateBoundary state={state} onRetry={() => void chain.refetch()}>
          {chain.data === null || chain.data === undefined ? null : <Tiers chain={chain.data} readOnly={mode === 'READ_ONLY'} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.change.tiers.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The permission of setChangeChainTiers (x-permission in openapi.json); the server judges the command again. */
const CONFIGURE_TIERS_PERMISSION = 'change.tiers.configure';

function Tiers({ chain, readOnly }: { chain: Chain; readOnly: boolean }) {
  const { t } = useTranslation();
  const projects = useProjectOptions();
  const projectLabel = projects.data?.find((project) => project.id === chain.projectId)?.label;
  const { config } = chain;
  const locked = config?.locked === true;
  const set = useSetTiers();
  const [form, setForm] = useState<TiersForm>(emptyTiers(config?.tierCount));
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);
  const problems = validateTiers(form);
  const { permissions } = useSession();
  // The server says the membership may set the tiers of this project; the session of the person must hold the right too.
  const editable = chain.canConfigure && !readOnly && !locked && (permissions === undefined || permissions.includes(CONFIGURE_TIERS_PERMISSION));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    setDone(false);
    if (set.isPending || Object.keys(problems).length > 0) return;
    set.mutate({ projectId: chain.projectId, tierCount: tiersBody(form).tier_count }, { onSuccess: () => setDone(true) });
  };

  return (
    <SectionCard title={t('ctr.change.tiers.form.title')}>
      {locked && config !== undefined ? (
        <p className="callout warning" role="status" data-testid="locked-notice">
          {t('ctr.change.tiers.locked.notice', { count: config.tierCount, code: config.lockedBy?.code ?? config.lockedBy?.id ?? t('ctr.change.none.text') })}
        </p>
      ) : null}
      {!locked && !chain.canConfigure ? (
        <p className="callout" role="status" data-testid="no-command">
          {t('ctr.change.tiers.readOnly.notice')}
        </p>
      ) : null}
      {/* The policy as it stands (CTR-20 fields): the project, whether it is locked and by which first change, and who set it. */}
      <dl className="ctr-facts" data-testid="tiers-facts">
        <dt>{t('ctr.change.tiers.fact.project')}</dt>
        <dd>{projectLabel ?? chain.projectId.slice(0, 8)}</dd>
        <dt>{t('ctr.change.tiers.fact.locked')}</dt>
        <dd data-testid="fact-locked">{locked ? t('ctr.change.tiers.fact.lockedYes', { day: config?.lockedAt?.slice(0, 10) ?? '' }) : t('ctr.change.tiers.fact.lockedNo')}</dd>
        <dt>{t('ctr.change.tiers.fact.firstChange')}</dt>
        <dd data-testid="fact-first-change">{config?.lockedBy == null ? t('ctr.change.tiers.fact.noChange') : (config.lockedBy.code ?? config.lockedBy.id.slice(0, 8))}</dd>
        <dt>{t('ctr.change.tiers.fact.setBy')}</dt>
        <dd data-testid="fact-set-by">{config === undefined ? t('ctr.change.tiers.fact.notSet') : config.setBy === null ? t('ctr.change.none.text') : config.setBy.slice(0, 8)}</dd>
      </dl>
      <form onSubmit={send} noValidate>
        {set.isError ? (
          <p className="callout warning" role="alert" data-testid="refusal">
            {problemMessage(t, describeProblem(set.error))}
          </p>
        ) : null}
        <fieldset className="field" data-field="tier-count" disabled={!editable}>
          <legend>{t('ctr.change.tiers.field.legend')}</legend>
          {TIER_COUNTS.map((count) => (
            <label key={count} className="radio">
              <input type="radio" name="tier-count" value={count} data-tiers={count} checked={form.tierCount === `${count}`} onChange={() => setForm({ tierCount: `${count}` })} />{' '}
              {t('ctr.change.tiers.option', { count, stages: stagesOf(count).map((stage) => stageLabel(t, stage)).join(' → ') })}
            </label>
          ))}
          {submitted && problems.tierCount !== undefined ? (
            <small role="alert" className="field-error">
              {formProblemMessage(t, problems.tierCount)}
            </small>
          ) : null}
        </fieldset>
        {done ? (
          <p className="callout" role="status" data-testid="done">
            {t('ctr.change.tiers.done.notice')}
          </p>
        ) : null}
        <div className="formfooter">
          <Link className="button" to={chainLink(chain.projectId)} data-testid="board-link">
            {t('ctr.change.tiers.board.link')}
          </Link>
          {editable ? (
            <button type="submit" className="primary" disabled={set.isPending}>
              {set.isPending ? t('ctr.change.dialog.pending') : t('ctr.change.tiers.submit')}
            </button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}
