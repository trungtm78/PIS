import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../dgv.css';
import { useMembers } from '../hooks';
import { MEMBER_READ_PERMISSION } from '../model';
import type { MemberOption } from '../model';
import { useCreateMilestone, useMilestones, useRubrics } from './hooks';
import { milestoneStatusLabel, pillarLabel, problemMessage } from './labels';
import { EMPTY_MILESTONE, MANAGE_PERMISSION, PILLARS, describeMaturityProblem, personName, validateMilestone } from './model';
import type { FormProblem, Milestone, MilestoneField, MilestoneForm } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
const pill = (milestone: Milestone): string => (milestone.status === 'ACHIEVED' ? 'green' : milestone.status === 'MISSED' ? 'red' : 'gray');

/**
 * DGV-17: the roadmap of maturity (ST-DGV-008, DGV 3.1 F8, UAT-AC494): a milestone for a pillar with the level to reach, the last day, its owner, the criteria to leave by and the evidence it needs; it is ACHIEVED only by a
 * published assessment that reached the level, and MISSED when its day passes without one. The form to plan the next milestone is for those who manage the maturity.
 */
export default function RoadmapScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <RoadmapContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RoadmapContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = holds(permissions, MANAGE_PERMISSION, mode);
  const milestones = useMilestones();
  const rubrics = useRubrics();
  // The link of a notification names the milestone it is about.
  const [params] = useSearchParams();
  const focused = params.get('milestone');
  const membersReadable = permissions === undefined || permissions.includes(MEMBER_READ_PERMISSION);
  const members = useMembers(mayManage && membersReadable);
  const state = useScreenState({ isLoading: milestones.isLoading, error: milestones.error, data: milestones.data, isEmpty: () => false });
  const list = milestones.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.maturity.road.title')}</h1>
          <p>{t('dgv.maturity.road.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void milestones.refetch()}>
        {list.length === 0 ? (
          <p className="card" data-testid="no-milestones">
            {t('dgv.maturity.road.none')}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table" data-testid="milestones" aria-label={t('dgv.maturity.road.table')}>
              <thead>
                <tr>
                  <th scope="col">{t('dgv.maturity.col.pillar')}</th>
                  <th scope="col">{t('dgv.maturity.col.target')}</th>
                  <th scope="col">{t('dgv.maturity.col.due')}</th>
                  <th scope="col">{t('dgv.maturity.col.owner')}</th>
                  <th scope="col">{t('dgv.maturity.col.exit')}</th>
                  <th scope="col">{t('dgv.maturity.col.evidenceNeeded')}</th>
                  <th scope="col">{t('dgv.maturity.col.milestone')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((milestone) => (
                  <tr key={milestone.id} data-milestone={milestone.id} data-status={milestone.status} aria-current={milestone.id === focused ? 'true' : undefined}>
                    <td>{pillarLabel(t, milestone.pillarCode)}</td>
                    <td>{milestone.targetLevel}</td>
                    <td>{milestone.dueOn}</td>
                    <td>{personName(milestone.owner)}</td>
                    <td>{milestone.exitCriteria}</td>
                    <td>{milestone.evidenceRequired.join('; ')}</td>
                    <td>
                      <span className={`pill ${pill(milestone)}`}>{milestoneStatusLabel(t, milestone.status)}</span>
                      {milestone.status === 'ACHIEVED' ? <p className="sub">{t('dgv.maturity.road.provedBy')}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sub" data-testid="road-rule">
          {t('dgv.maturity.road.rule')}
        </p>
        {mayManage ? (
          <PlanPanel rubrics={(rubrics.data ?? []).filter((rubric) => rubric.status === 'PUBLISHED')} people={members.data ?? []} membersFailed={members.isError} membersReadable={membersReadable} />
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('dgv.maturity.road.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function PlanPanel({
  rubrics,
  people,
  membersFailed,
  membersReadable,
}: {
  rubrics: Array<{ id: string; code: string; revision: number }>;
  people: MemberOption[];
  membersFailed: boolean;
  membersReadable: boolean;
}) {
  const { t } = useTranslation();
  const send = useCreateMilestone();
  const [form, setForm] = useState<MilestoneForm>(EMPTY_MILESTONE);
  const [problems, setProblems] = useState<Partial<Record<MilestoneField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const set = (patch: Partial<MilestoneForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('dgv.maturity.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateMilestone(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setForm(EMPTY_MILESTONE);
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.maturity.plan.title')}>
      <h2>{t('dgv.maturity.plan.title')}</h2>
      {!membersReadable || membersFailed ? (
        <p className="callout warning" role="status" data-testid="members-unavailable">
          {membersReadable ? t('dgv.maturity.start.membersFailed') : t('dgv.maturity.start.membersDenied')}
        </p>
      ) : null}
      <Field id="plan-rubric" label={t('dgv.maturity.start.rubric')} error={message(problems.rubricId, '')}>
        <select id="plan-rubric" value={form.rubricId} aria-invalid={problems.rubricId !== undefined} onChange={(event) => set({ rubricId: event.target.value })}>
          <option value="" />
          {rubrics.map((rubric) => (
            <option key={rubric.id} value={rubric.id}>
              {t('dgv.maturity.rubric.heading', { code: rubric.code, revision: rubric.revision })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plan-pillar" label={t('dgv.maturity.col.pillar')} error={undefined}>
        <select id="plan-pillar" value={form.pillar} onChange={(event) => set({ pillar: event.target.value })}>
          {PILLARS.map((pillar) => (
            <option key={pillar} value={pillar}>
              {pillarLabel(t, pillar)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plan-target" label={t('dgv.maturity.plan.target')} error={message(problems.targetLevel, t('dgv.maturity.plan.target.invalid'))}>
        <select id="plan-target" value={form.targetLevel} aria-invalid={problems.targetLevel !== undefined} onChange={(event) => set({ targetLevel: event.target.value })}>
          <option value="" />
          {[1, 2, 3, 4, 5].map((level) => (
            <option key={level} value={String(level)}>
              {level}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plan-due" label={t('dgv.maturity.plan.due')} error={message(problems.dueOn, t('dgv.maturity.plan.due.invalid'))}>
        <input id="plan-due" type="date" value={form.dueOn} aria-invalid={problems.dueOn !== undefined} onChange={(event) => set({ dueOn: event.target.value })} />
      </Field>
      <Field id="plan-owner" label={t('dgv.maturity.col.owner')} error={message(problems.ownerId, '')}>
        <select id="plan-owner" value={form.ownerId} aria-invalid={problems.ownerId !== undefined} onChange={(event) => set({ ownerId: event.target.value })}>
          <option value="" />
          {people.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plan-exit" label={t('dgv.maturity.col.exit')} error={message(problems.exitCriteria, t('dgv.maturity.plan.exit.invalid'))}>
        <textarea id="plan-exit" rows={2} value={form.exitCriteria} aria-invalid={problems.exitCriteria !== undefined} onChange={(event) => set({ exitCriteria: event.target.value })} />
      </Field>
      <Field id="plan-evidence" label={t('dgv.maturity.col.evidenceNeeded')} hint={t('dgv.maturity.plan.evidence.hint')} error={undefined}>
        <textarea id="plan-evidence" rows={2} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="plan-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="plan-saved">
          {t('dgv.maturity.plan.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('dgv.maturity.plan.submit')}
        </button>
      </div>
    </form>
  );
}
