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
import { useAssessments, useDecideAssessment, useEvidence, useRecordEvidence, useReviewEvidence, useRubrics, useScore, useStartAssessment } from './hooks';
import { assessmentStatusLabel, confidenceLabel, kindLabel, overallLabel, pillarLabel, problemMessage, reviewLabel, scopeLabel, stateLabel } from './labels';
import {
  CONFIDENCES,
  CRITERION_STATES,
  EMPTY_RECORD,
  EMPTY_START,
  MANAGE_PERMISSION,
  SCOPES,
  actionsFor,
  awaitsReview,
  describeMaturityProblem,
  isEvidenceKind,
  personName,
  validateRecord,
  validateStart,
} from './model';
import type { Assessment, CriterionScore, EvidenceRow, FormProblem, RecordField, RecordForm, StartField, StartForm } from './model';

const NONE = '—';
const holds = (permissions: readonly string[] | undefined, permission: string, mode: string | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));

/**
 * DGV-16: the assessment of the maturity of data governance (ST-DGV-008, DGV 3.1 F8, BR-DGV-08, UAT-AC53, UAT-AC492): for the assessment chosen, the pillars and the criteria with what each counts as (assessed with a level,
 * not assessed, or not applicable), the coverage against the share the rubric asks for and the total only when it is computed; the assessor records a criterion with its evidence, the reviewer accepts or rejects it, and somebody
 * other than the assessor publishes the assessment. Missing evidence is NOT_ASSESSED here, never a level.
 */
export default function AssessmentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no form of the one is left open for the other.
  return <AssessmentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AssessmentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = holds(permissions, MANAGE_PERMISSION, mode);
  const assessments = useAssessments();
  const rubrics = useRubrics();
  const members = useMembers(mayManage && (permissions === undefined || permissions.includes(MEMBER_READ_PERMISSION)));
  // The link of a notification names the assessment it is about.
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState(params.get('assessment') ?? '');
  const state = useScreenState({ isLoading: assessments.isLoading, error: assessments.error, data: assessments.data, isEmpty: () => false });
  const list = assessments.data ?? [];
  const selected = list.find((assessment) => assessment.id === chosen) ?? list[0];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.maturity.assess.title')}</h1>
          <p>{t('dgv.maturity.assess.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void assessments.refetch()}>
        {selected === undefined ? (
          <p className="card" data-testid="no-assessment">
            {t('dgv.maturity.assess.none')}
          </p>
        ) : (
          <>
            <Field id="assessment-choice" label={t('dgv.maturity.assess.choose')} error={undefined}>
              <select id="assessment-choice" value={selected.id} onChange={(event) => setChosen(event.target.value)}>
                {list.map((assessment) => (
                  <option key={assessment.id} value={assessment.id}>
                    {t('dgv.maturity.assess.option', {
                      period: assessment.periodCode,
                      rubric: t('dgv.maturity.rubric.heading', { code: assessment.rubricCode, revision: assessment.rubricRevision }),
                      status: assessmentStatusLabel(t, assessment.status),
                    })}
                  </option>
                ))}
              </select>
            </Field>
            <AssessmentView key={selected.id} assessment={selected} />
          </>
        )}
        {mayManage ? (
          <StartPanel
            rubrics={(rubrics.data ?? []).filter((rubric) => rubric.status === 'PUBLISHED')}
            people={members.data ?? []}
            membersFailed={members.isError}
            membersReadable={permissions === undefined || permissions.includes(MEMBER_READ_PERMISSION)}
          />
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('dgv.maturity.assess.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function AssessmentView({ assessment }: { assessment: Assessment }) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const score = useScore(assessment.id);
  const evidence = useEvidence(assessment.id);
  const state = useScreenState({ isLoading: score.isLoading || evidence.isLoading, error: score.error ?? evidence.error, data: [score.data, evidence.data], isEmpty: () => false });
  const actions = actionsFor(assessment, permissions, mode, tenant?.membershipId);
  const rows = new Map((evidence.data ?? []).map((row) => [row.id, row]));
  return (
    <section className="card" aria-labelledby="assessment-title" data-assessment={assessment.id} data-status={assessment.status}>
      <h2 id="assessment-title">{t('dgv.maturity.assess.heading', { period: assessment.periodCode })}</h2>
      <dl>
        <div>
          <dt>{t('dgv.maturity.assess.status')}</dt>
          <dd>
            <span className={`pill ${assessment.status === 'PUBLISHED' ? 'green' : assessment.status === 'REJECTED' ? 'red' : 'gray'}`}>{assessmentStatusLabel(t, assessment.status)}</span>
          </dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.assess.scope')}</dt>
          <dd>{assessment.scopeRef === null ? scopeLabel(t, assessment.scopeKind) : `${scopeLabel(t, assessment.scopeKind)} · ${assessment.scopeRef}`}</dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.assess.rubric')}</dt>
          <dd>{t('dgv.maturity.rubric.heading', { code: assessment.rubricCode, revision: assessment.rubricRevision })}</dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.assess.assessor')}</dt>
          <dd data-testid="assessor">{personName(assessment.assessor)}</dd>
        </div>
        <div>
          <dt>{t('dgv.maturity.assess.reviewer')}</dt>
          <dd data-testid="reviewer">{personName(assessment.reviewer)}</dd>
        </div>
      </dl>
      <StateBoundary
        state={state}
        onRetry={() => {
          void score.refetch();
          void evidence.refetch();
        }}
      >
        {score.data === undefined ? null : (
          <>
            <div className="metrics" data-testid="score">
              <div className="metric" data-testid="coverage">
                <span className="sub">{t('dgv.maturity.score.coverage')}</span>
                <strong>{score.data.coveragePercent}%</strong>
                <span className="sub">{t('dgv.maturity.score.asked', { share: score.data.minCoveragePct })}</span>
              </div>
              <div className="metric" data-testid="overall" data-state={score.data.overallState}>
                <span className="sub">{t('dgv.maturity.score.overall')}</span>
                <strong>{score.data.overallLevel ?? overallLabel(t, score.data.overallState)}</strong>
                {score.data.overallState === 'NOT_COMPUTED' ? <span className="sub">{t('dgv.maturity.score.noTotal')}</span> : null}
              </div>
              <div className="metric" data-testid="counts">
                <span className="sub">{t('dgv.maturity.score.counts')}</span>
                <strong>{t('dgv.maturity.score.countsValue', { assessed: score.data.assessed, notAssessed: score.data.notAssessed, notApplicable: score.data.notApplicable })}</strong>
              </div>
            </div>
            <h3>{t('dgv.maturity.pillars.title')}</h3>
            <div className="tablewrap">
              <table className="table" data-testid="pillars" aria-label={t('dgv.maturity.pillars.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('dgv.maturity.col.pillar')}</th>
                    <th scope="col">{t('dgv.maturity.col.weight')}</th>
                    <th scope="col">{t('dgv.maturity.col.state')}</th>
                    <th scope="col">{t('dgv.maturity.col.currentLevel')}</th>
                  </tr>
                </thead>
                <tbody>
                  {score.data.pillars.map((pillar) => (
                    <tr key={pillar.code} data-pillar={pillar.code} data-state={pillar.state}>
                      <td>{pillarLabel(t, pillar.code)}</td>
                      <td>{pillar.weight}</td>
                      <td>{pillar.state === 'ASSESSED' ? stateLabel(t, 'ASSESSED') : stateLabel(t, 'NOT_ASSESSED')}</td>
                      <td>{pillar.level ?? NONE}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>{t('dgv.maturity.criteria.title')}</h3>
            <div className="tablewrap">
              <table className="table" data-testid="criteria" aria-label={t('dgv.maturity.criteria.title')}>
                <thead>
                  <tr>
                    <th scope="col">{t('dgv.maturity.col.pillar')}</th>
                    <th scope="col">{t('dgv.maturity.col.criterion')}</th>
                    <th scope="col">{t('dgv.maturity.col.state')}</th>
                    <th scope="col">{t('dgv.maturity.col.currentLevel')}</th>
                    <th scope="col">{t('dgv.maturity.col.review')}</th>
                    <th scope="col">{t('dgv.maturity.col.expires')}</th>
                    <th scope="col">{t('dgv.maturity.col.evidence')}</th>
                    <th scope="col">{t('dgv.maturity.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {score.data.criteria.map((criterion) => (
                    <CriterionRow key={criterion.evidenceId} assessment={assessment} criterion={criterion} row={rows.get(criterion.evidenceId)} mayRecord={actions.record} mayReview={actions.review} />
                  ))}
                </tbody>
              </table>
            </div>
            {actions.decide ? <DecidePanel assessment={assessment} /> : null}
          </>
        )}
      </StateBoundary>
    </section>
  );
}

function CriterionRow({
  assessment,
  criterion,
  row,
  mayRecord,
  mayReview,
}: {
  assessment: Assessment;
  criterion: CriterionScore;
  row: EvidenceRow | undefined;
  mayRecord: boolean;
  mayReview: boolean;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const reviewing = mayReview && row !== undefined && awaitsReview(row);
  return (
    <>
      <tr data-criterion={criterion.criterionCode} data-state={criterion.state} data-review={criterion.reviewStatus}>
        <td>{pillarLabel(t, criterion.pillarCode)}</td>
        <td>
          <code>{criterion.criterionCode}</code>
        </td>
        <td>{stateLabel(t, criterion.state)}</td>
        <td>{criterion.level ?? NONE}</td>
        <td>{reviewLabel(t, criterion.reviewStatus)}</td>
        <td>{criterion.evidenceExpiresOn ?? NONE}</td>
        <td>{criterion.evidenceCount}</td>
        <td>
          {mayRecord && row !== undefined ? (
            <button type="button" aria-expanded={recording} onClick={() => setRecording((value) => !value)}>
              {t('dgv.maturity.record.open', { criterion: criterion.criterionCode })}
            </button>
          ) : null}
          {reviewing && row !== undefined ? <ReviewPanel row={row} /> : null}
        </td>
      </tr>
      {row !== undefined && row.state !== 'NOT_ASSESSED' ? (
        <tr data-submitted-for={criterion.criterionCode}>
          <td colSpan={8}>
            <Submitted row={row} />
          </td>
        </tr>
      ) : null}
      {recording && row !== undefined ? (
        <tr data-record-for={criterion.criterionCode}>
          <td colSpan={8}>
            <RecordPanel assessment={assessment} row={row} onDone={() => setRecording(false)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** What the assessor submitted for a criterion: the level proposed, the evidence, the sample and confidence, or why it does not apply - what a reviewer decides on. */
function Submitted({ row }: { row: EvidenceRow }) {
  const { t } = useTranslation();
  return (
    <dl className="sub" data-testid={`submitted-${row.criterionCode}`}>
      {row.state === 'ASSESSED' ? (
        <div>
          <dt>{t('dgv.maturity.submitted.level')}</dt>
          <dd>{row.level ?? NONE}</dd>
        </div>
      ) : (
        <div>
          <dt>{t('dgv.maturity.submitted.na')}</dt>
          <dd>{row.naReason ?? NONE}</dd>
        </div>
      )}
      {row.evidenceCount > row.evidenceRefs.length ? (
        <div>
          <dt>{t('dgv.maturity.col.evidence')}</dt>
          <dd data-testid={`hidden-${row.criterionCode}`}>{t('dgv.maturity.submitted.hidden', { count: row.evidenceCount })}</dd>
        </div>
      ) : null}
      {row.evidenceRefs.length === 0 ? null : (
        <div>
          <dt>{t('dgv.maturity.col.evidence')}</dt>
          <dd>
            <ul>
              {row.evidenceRefs.map((evidence, index) => (
                <li key={`${evidence.kind}:${evidence.ref}:${index}`}>
                  {isEvidenceKind(evidence.kind) ? kindLabel(t, evidence.kind) : evidence.kind}: {evidence.ref}
                  {evidence.note === null ? '' : ` (${evidence.note})`}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {row.sampleSize === null ? null : (
        <div>
          <dt>{t('dgv.maturity.record.sample')}</dt>
          <dd>{row.sampleSize}</dd>
        </div>
      )}
      {row.confidence === null ? null : (
        <div>
          <dt>{t('dgv.maturity.record.confidence')}</dt>
          <dd>{confidenceLabel(t, row.confidence)}</dd>
        </div>
      )}
    </dl>
  );
}

function RecordPanel({ assessment, row, onDone }: { assessment: Assessment; row: EvidenceRow; onDone: () => void }) {
  const { t } = useTranslation();
  const send = useRecordEvidence();
  const [form, setForm] = useState<RecordForm>(EMPTY_RECORD);
  const [problems, setProblems] = useState<Partial<Record<RecordField, FormProblem>>>({});
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const set = (patch: Partial<RecordForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('dgv.maturity.form.required') : invalid);
  const id = (name: string): string => `record-${row.criterionCode}-${name}`;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateRecord(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate({ assessmentId: assessment.id, evidence: row, form }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t('dgv.maturity.record.title', { criterion: row.criterionCode })}>
      <Field id={id('state')} label={t('dgv.maturity.record.state')} error={undefined}>
        <select id={id('state')} value={form.state} onChange={(event) => set({ state: event.target.value as RecordForm['state'] })}>
          {CRITERION_STATES.map((state) => (
            <option key={state} value={state}>
              {stateLabel(t, state)}
            </option>
          ))}
        </select>
      </Field>
      {form.state === 'ASSESSED' ? (
        <>
          <Field id={id('level')} label={t('dgv.maturity.record.level')} error={message(problems.level, t('dgv.maturity.record.level.invalid'))}>
            <select id={id('level')} value={form.level} aria-invalid={problems.level !== undefined} onChange={(event) => set({ level: event.target.value })}>
              <option value="" />
              {[1, 2, 3, 4, 5].map((level) => (
                <option key={level} value={String(level)}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id={id('evidence')}
            label={t('dgv.maturity.record.evidence')}
            hint={t('dgv.maturity.record.evidence.hint')}
            error={message(problems.evidence, t('dgv.maturity.record.evidence.invalid'))}
          >
            <textarea id={id('evidence')} rows={3} value={form.evidence} aria-invalid={problems.evidence !== undefined} onChange={(event) => set({ evidence: event.target.value })} />
          </Field>
          <Field id={id('expires')} label={t('dgv.maturity.record.expires')} hint={t('dgv.maturity.record.expires.hint')} error={message(problems.expiresOn, t('dgv.maturity.record.expires.invalid'))}>
            <input id={id('expires')} type="date" value={form.expiresOn} aria-invalid={problems.expiresOn !== undefined} onChange={(event) => set({ expiresOn: event.target.value })} />
          </Field>
          <Field id={id('sample')} label={t('dgv.maturity.record.sample')} error={message(problems.sampleSize, t('dgv.maturity.record.sample.invalid'))}>
            <input id={id('sample')} value={form.sampleSize} aria-invalid={problems.sampleSize !== undefined} onChange={(event) => set({ sampleSize: event.target.value })} />
          </Field>
          <Field id={id('confidence')} label={t('dgv.maturity.record.confidence')} error={undefined}>
            <select id={id('confidence')} value={form.confidence} onChange={(event) => set({ confidence: event.target.value })}>
              <option value="" />
              {CONFIDENCES.map((confidence) => (
                <option key={confidence} value={confidence}>
                  {confidenceLabel(t, confidence)}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : null}
      {form.state === 'NOT_APPLICABLE' ? (
        <Field id={id('na')} label={t('dgv.maturity.record.na')} error={message(problems.naReason, t('dgv.maturity.record.na.invalid'))}>
          <input id={id('na')} value={form.naReason} aria-invalid={problems.naReason !== undefined} onChange={(event) => set({ naReason: event.target.value })} />
        </Field>
      ) : null}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="record-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('dgv.maturity.record.submit')}
        </button>
      </div>
    </form>
  );
}

function ReviewPanel({ row }: { row: EvidenceRow }) {
  const { t } = useTranslation();
  const send = useReviewEvidence();
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const decide = (decision: 'ACCEPTED' | 'REJECTED'): void => {
    if (note.trim().length < 10) {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (!send.isPending) send.mutate({ evidence: row, decision, note });
  };
  const id = `review-note-${row.criterionCode}`;
  return (
    <div data-review-for={row.criterionCode}>
      <Field id={id} label={t('dgv.maturity.review.note', { criterion: row.criterionCode })} error={missing ? t('dgv.maturity.review.note.required') : undefined}>
        <input id={id} value={note} aria-invalid={missing} onChange={(event) => setNote(event.target.value)} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="review-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      <div className="formfooter">
        <button type="button" className="primary" disabled={send.isPending} onClick={() => decide('ACCEPTED')}>
          {t('dgv.maturity.review.accept', { criterion: row.criterionCode })}
        </button>
        <button type="button" disabled={send.isPending} onClick={() => decide('REJECTED')}>
          {t('dgv.maturity.review.reject', { criterion: row.criterionCode })}
        </button>
      </div>
    </div>
  );
}

function DecidePanel({ assessment }: { assessment: Assessment }) {
  const { t } = useTranslation();
  const send = useDecideAssessment();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const decide = (decision: 'approve' | 'return' | 'reject'): void => {
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (!send.isPending) send.mutate({ id: assessment.id, version: assessment.version, decision, reason });
  };
  return (
    <form aria-label={t('dgv.maturity.decide.title')} noValidate onSubmit={(event) => event.preventDefault()}>
      <h3>{t('dgv.maturity.decide.title')}</h3>
      <Field id="decide-reason" label={t('dgv.maturity.decide.reason')} error={missing ? t('dgv.maturity.decide.reason.required') : undefined}>
        <input id="decide-reason" value={reason} aria-invalid={missing} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="decide-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      <div className="formfooter">
        <button type="button" className="primary" disabled={send.isPending} onClick={() => decide('approve')}>
          {t('dgv.maturity.decide.approve')}
        </button>
        <button type="button" disabled={send.isPending} onClick={() => decide('return')}>
          {t('dgv.maturity.decide.return')}
        </button>
        <button type="button" disabled={send.isPending} onClick={() => decide('reject')}>
          {t('dgv.maturity.decide.reject')}
        </button>
      </div>
    </form>
  );
}

function StartPanel({
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
  const send = useStartAssessment();
  const [form, setForm] = useState<StartForm>(EMPTY_START);
  const [problems, setProblems] = useState<Partial<Record<StartField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const failure = send.isError ? describeMaturityProblem(send.error) : undefined;
  const set = (patch: Partial<StartForm>): void => setForm((value) => ({ ...value, ...patch }));
  const message = (problem: FormProblem | undefined, invalid: string): string | undefined => (problem === undefined ? undefined : problem === 'required' ? t('dgv.maturity.form.required') : invalid);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(false);
    const found = validateStart(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(form, {
      onSuccess: () => {
        setSaved(true);
        setForm(EMPTY_START);
      },
    });
  };

  const person = (field: 'assessorId' | 'reviewerId', label: string, error: string | undefined) => (
    <Field id={`start-${field}`} label={label} error={error}>
      <select id={`start-${field}`} value={form[field]} aria-invalid={problems[field] !== undefined} onChange={(event) => set({ [field]: event.target.value })}>
        <option value="" />
        {people.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.maturity.start.title')}>
      <h2>{t('dgv.maturity.start.title')}</h2>
      {!membersReadable || membersFailed ? (
        <p className="callout warning" role="status" data-testid="members-unavailable">
          {membersReadable ? t('dgv.maturity.start.membersFailed') : t('dgv.maturity.start.membersDenied')}
        </p>
      ) : null}
      <Field id="start-rubric" label={t('dgv.maturity.start.rubric')} error={message(problems.rubricId, '')}>
        <select id="start-rubric" value={form.rubricId} aria-invalid={problems.rubricId !== undefined} onChange={(event) => set({ rubricId: event.target.value })}>
          <option value="" />
          {rubrics.map((rubric) => (
            <option key={rubric.id} value={rubric.id}>
              {t('dgv.maturity.rubric.heading', { code: rubric.code, revision: rubric.revision })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="start-period" label={t('dgv.maturity.start.period')} hint={t('dgv.maturity.start.period.hint')} error={message(problems.period, t('dgv.maturity.start.period.invalid'))}>
        <input id="start-period" value={form.period} aria-invalid={problems.period !== undefined} onChange={(event) => set({ period: event.target.value })} />
      </Field>
      <Field id="start-scope" label={t('dgv.maturity.start.scope')} error={undefined}>
        <select id="start-scope" value={form.scopeKind} onChange={(event) => set({ scopeKind: event.target.value as StartForm['scopeKind'], scopeRef: '' })}>
          {SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {scopeLabel(t, scope)}
            </option>
          ))}
        </select>
      </Field>
      {form.scopeKind === 'TENANT' ? null : (
        <Field id="start-scope-ref" label={t('dgv.maturity.start.scopeRef')} error={message(problems.scopeRef, '')}>
          <input id="start-scope-ref" value={form.scopeRef} aria-invalid={problems.scopeRef !== undefined} onChange={(event) => set({ scopeRef: event.target.value })} />
        </Field>
      )}
      {person('assessorId', t('dgv.maturity.start.assessor'), message(problems.assessorId, ''))}
      {person('reviewerId', t('dgv.maturity.start.reviewer'), message(problems.reviewerId, t('dgv.maturity.start.reviewer.same')))}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="start-refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="start-saved">
          {t('dgv.maturity.start.saved')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('dgv.maturity.start.submit')}
        </button>
      </div>
    </form>
  );
}
