import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { classificationLabel, routeLabel } from '../labels';
import { CitationList } from './assist-components';
import { useAssistRun } from './assist-hooks';
import { basisHint, basisLabel, basisTone, checkKindLabel, codeText, completenessLabel, completenessNote, completenessTone, resultTone, reviewByLabel, reviewDetailText, reviewResultLabel, runStatusLabel, runStatusTone, scoreStatusLabel, scoreStatusTone, sectionLabel, severityLabel, severityTone, sourceKindLabel, verdictLabel, verdictNote, verdictTone } from './assist-labels';
import { PATHS, bpPercent, groupStatements, isUnsupported, shortId } from './assist-model';
import type { AssistRun, CriterionProposal, EvaluationView, ReviewItem, ReviewView, Statement } from './assist-model';
import { DecisionSection } from './decision-panels';

/**
 * The result of a run as every screen of the assistant shows it (LLM-22 to LLM-25): what it is (a proposal that is not applied), how complete it is, what was hidden or flagged, the review or the evaluation when the run was one,
 * the statements by what they rest on, and the decision of a person. A statement without a verified source is shown struck and flagged, never as a fact.
 */
export function RunView({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const completed = run.status === 'COMPLETED';
  const folded = run.review !== undefined || run.evaluation !== undefined;
  return (
    <div className="assist-run" data-testid="run-view" data-run-id={run.id} data-status={run.status} data-kind={run.kind}>
      <RunBanners run={run} />
      {!completed ? <RefusedCard run={run} /> : null}
      {completed && run.review !== undefined ? <ReviewResultView review={run.review} /> : null}
      {completed && run.evaluation !== undefined ? <EvaluationResultView evaluation={run.evaluation} /> : null}
      {completed && folded ? (
        <details className="assist-folded" data-testid="statements-folded">
          <summary>{t('llm.assist.statements.foldedTitle', { count: run.statements.length })}</summary>
          <StatementsSection run={run} />
        </details>
      ) : null}
      {completed && !folded ? <StatementsSection run={run} /> : null}
      {completed ? <OpenQuestions run={run} /> : null}
      {receipt === undefined ? null : (
        <p className="callout assist-receipt" role="status" data-testid="decision-receipt">
          {receipt}
        </p>
      )}
      <DecisionSection run={run} onDone={setReceipt} />
    </div>
  );
}

export function RunBanners({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  const completed = run.status === 'COMPLETED';
  return (
    <div className="assist-banners">
      <p className="callout" data-testid="advisory-note">
        {t('llm.assist.run.advisory')}
      </p>
      <ul className="assist-chips" aria-label={t('llm.assist.run.chips')}>
        <li>
          <StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(t, run.status)}</StatusPill>
        </li>
        {completed ? (
          <li data-testid="completeness">
            <StatusPill tone={completenessTone(run.completeness)}>{completenessLabel(t, run.completeness)}</StatusPill>
          </li>
        ) : null}
        {run.classification === null ? null : (
          <li data-testid="classification-chip">
            <StatusPill tone="neutral">{t('llm.assist.run.classification', { value: classificationLabel(t, run.classification) })}</StatusPill>
          </li>
        )}
        {run.routeClass === null ? null : (
          <li data-testid="route-chip">
            <StatusPill tone="neutral">{t('llm.assist.run.route', { value: routeLabel(t, run.routeClass) })}</StatusPill>
          </li>
        )}
      </ul>
      {completed ? <p className="sub">{completenessNote(t, run.completeness)}</p> : null}
      {run.counts.withheldCitations > 0 ? (
        <p className="callout warning" data-testid="withheld-note">
          {t('llm.assist.run.withheld', { count: run.counts.withheldCitations })}
        </p>
      ) : null}
      {run.counts.injectionSignals > 0 ? (
        <p className="callout warning" data-testid="injection-note">
          {t('llm.assist.run.injection', { count: run.counts.injectionSignals })}
        </p>
      ) : null}
      {run.truncated ? (
        <p className="callout" data-testid="truncated-note">
          {t('llm.assist.run.truncated')}
        </p>
      ) : null}
      {completed ? (
        <dl className="assist-counts" aria-label={t('llm.assist.run.counts')}>
          <div>
            <dt>{t('llm.assist.counts.statements')}</dt>
            <dd data-testid="count-statements">{run.counts.statements}</dd>
          </div>
          <div>
            <dt>{t('llm.assist.counts.verified')}</dt>
            <dd data-testid="count-verified">{run.counts.verified}</dd>
          </div>
          <div>
            <dt>{t('llm.assist.counts.assumptions')}</dt>
            <dd>{run.counts.assumptions}</dd>
          </div>
          <div>
            <dt>{t('llm.assist.counts.unsupported')}</dt>
            <dd data-testid="count-unsupported">{run.counts.unsupported}</dd>
          </div>
        </dl>
      ) : null}
      {run.sources.length === 0 ? null : (
        <details className="assist-sources-read" data-testid="sources-read">
          <summary>{t('llm.assist.run.sourcesRead', { count: run.sources.length })}</summary>
          <ul>
            {run.sources.map((source) => (
              <li key={`${source.kind}:${source.id}`}>
                {sourceKindLabel(t, source.kind)} · {source.title === '' ? shortId(source.id) : source.title}
                {source.classification === null ? '' : ` · ${classificationLabel(t, source.classification)}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A run that was refused or failed: what stopped it, in words, and that nothing was answered. */
function RefusedCard({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  return (
    <div className="callout warning assist-refused" role="alert" data-testid="run-refused" data-refusal-code={run.refusalCode ?? ''}>
      <strong>{run.status === 'REFUSED' ? t('llm.assist.refused.title') : t('llm.assist.failed.title')}</strong>
      <p>{run.refusalCode === null ? t('llm.assist.refused.noCode') : codeText(t, run.refusalCode)}</p>
      <p className="sub">{t('llm.assist.refused.nothing')}</p>
    </div>
  );
}

function OpenQuestions({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  if (run.openQuestions.length === 0 && run.missingSections.length === 0) return null;
  return (
    <div className="assist-open" data-testid="open-questions">
      {run.openQuestions.length === 0 ? null : (
        <SectionCard title={t('llm.assist.open.title')}>
          <ul>
            {run.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </SectionCard>
      )}
      {run.missingSections.length === 0 ? null : (
        <p className="callout warning" data-testid="missing-sections">
          {t('llm.assist.open.missingSections', { sections: run.missingSections.map((section) => sectionLabel(t, section)).join(', ') })}
        </p>
      )}
    </div>
  );
}

// ---- the statements ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function StatementsSection({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  const groups = groupStatements(run.statements);
  if (groups.length === 0) {
    return (
      <p className="sub" data-testid="statements-none">
        {t('llm.assist.statements.none')}
      </p>
    );
  }
  return (
    <div className="assist-statements" data-testid="statements">
      {groups.map((group) => (
        <section key={group.basis} className="assist-group" data-basis={group.basis} aria-label={t('llm.assist.statements.group', { basis: basisLabel(t, group.basis), count: group.statements.length })}>
          <h3>
            <StatusPill tone={basisTone(group.basis)}>{basisLabel(t, group.basis)}</StatusPill> <span className="sub">{group.statements.length}</span>
          </h3>
          <p className="sub">{basisHint(t, group.basis)}</p>
          <ul>
            {group.statements.map((statement) => (
              <StatementItem key={statement.id} statement={statement} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StatementItem({ statement }: { statement: Statement }) {
  const { t } = useTranslation();
  const unsupported = isUnsupported(statement);
  return (
    <li className={unsupported ? 'assist-statement assist-statement--unsupported' : 'assist-statement'} data-statement-id={statement.id} data-presented-as={statement.presentedAs} data-verification={statement.verification}>
      <div className="assist-statement__head">
        <code>{statement.id}</code>
        {unsupported ? <StatusPill tone="danger">{t('llm.assist.statement.noSource')}</StatusPill> : null}
        {statement.section === null ? null : <StatusPill tone="neutral">{sectionLabel(t, statement.section)}</StatusPill>}
        {statement.itemCode === null ? null : <StatusPill tone="neutral">{statement.itemCode}</StatusPill>}
        {statement.criterionCode === null ? null : <StatusPill tone="neutral">{statement.criterionCode}</StatusPill>}
        {statement.result === null ? null : <StatusPill tone={resultTone(statement.result)}>{reviewResultLabel(t, statement.result)}</StatusPill>}
        {statement.score === null ? null : <span className="sub">{t('llm.assist.statement.score', { score: statement.score })}</span>}
      </div>
      <p className="assist-statement__text">{unsupported ? <del data-testid="struck-text">{statement.text}</del> : statement.text}</p>
      {unsupported && statement.claimedBasis !== '' && statement.claimedBasis !== statement.presentedAs ? <p className="sub">{t('llm.assist.statement.claimed', { basis: statement.claimedBasis })}</p> : null}
      {unsupported && statement.problems.length > 0 ? (
        <p className="sub" data-testid="statement-problems">
          {t('llm.assist.statement.problems', { problems: statement.problems.join(', ') })}
        </p>
      ) : null}
      {statement.presentedAs === 'INFERENCE' && statement.dependsOn.length > 0 ? (
        <p className="sub" data-testid="depends-on">
          {t('llm.assist.statement.dependsOn', { ids: statement.dependsOn.join(', ') })}
        </p>
      ) : null}
      <CitationList citations={statement.citations} />
    </li>
  );
}

// ---- the review of a file ----------------------------------------------------------------------------------------------------------------------------------------------------

/** The result of a review against a checklist: the verdict (which is advice and blocks nothing), then each item with its severity, its result (a result that is not proven is not a pass) and its citations. */
export function ReviewResultView({ review }: { review: ReviewView }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('llm.review.result.title')} status={<StatusPill tone={verdictTone(review.verdict)}>{verdictLabel(t, review.verdict)}</StatusPill>}>
      <p className="callout" data-testid="review-verdict" data-verdict={review.verdict}>
        <strong>{verdictLabel(t, review.verdict)}.</strong> {verdictNote(t, review.verdict)}
      </p>
      <p className="sub" data-testid="review-counts">
        {t('llm.review.result.counts', { pass: review.counts.pass, fail: review.counts.fail, unknown: review.counts.unknown, blockers: review.counts.blockersOpen })}
      </p>
      <DataTable<ReviewItem>
        caption={t('llm.review.result.caption')}
        rows={review.items}
        rowKey={(item) => item.itemCode}
        rowAttrs={(item) => ({ 'data-item-code': item.itemCode, 'data-result': item.result, 'data-severity-name': item.severity })}
        columns={[
          { key: 'code', header: t('llm.review.column.code'), pinned: true, render: (item) => <code>{item.itemCode}</code> },
          {
            key: 'label',
            header: t('llm.review.column.label'),
            render: (item) => (
              <>
                {item.label}
                {item.kind === null ? null : <span className="sub"> · {checkKindLabel(t, item.kind)}</span>}
              </>
            ),
          },
          { key: 'severity', header: t('llm.review.column.severity'), render: (item) => <StatusPill tone={severityTone(item.severity)}>{severityLabel(t, item.severity)}</StatusPill> },
          { key: 'result', header: t('llm.review.column.result'), render: (item) => <StatusPill tone={resultTone(item.result)}>{reviewResultLabel(t, item.result)}</StatusPill> },
          { key: 'by', header: t('llm.review.column.by'), render: (item) => reviewByLabel(t, item.by) },
          {
            key: 'detail',
            header: t('llm.review.column.detail'),
            render: (item) => (
              <>
                {item.detail === null ? null : <span>{reviewDetailText(t, item.detail)}</span>}
                <CitationList citations={item.citations} />
              </>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

// ---- the proposals of an evaluation ---------------------------------------------------------------------------------------------------------------------------------

/** The scores the assistant proposed for each criterion, with its weight; a score that was withheld says why, and no total is shown here: the total comes only from the scores a person accepts. */
export function EvaluationResultView({ evaluation }: { evaluation: EvaluationView }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('llm.evaluation.result.title')} status={evaluation.setCode === null ? undefined : <StatusPill tone="neutral">{evaluation.setCode}</StatusPill>}>
      <p className="sub">{t('llm.evaluation.result.scale', { max: evaluation.scaleMax })}</p>
      <DataTable<CriterionProposal>
        caption={t('llm.evaluation.result.caption')}
        rows={evaluation.criteria}
        rowKey={(criterion) => criterion.code}
        rowAttrs={(criterion) => ({ 'data-criterion-code': criterion.code, 'data-status': criterion.status })}
        columns={[
          { key: 'code', header: t('llm.evaluation.column.code'), pinned: true, render: (criterion) => <code>{criterion.code}</code> },
          { key: 'label', header: t('llm.evaluation.column.label'), render: (criterion) => criterion.label },
          { key: 'weight', header: t('llm.evaluation.column.weight'), align: 'right', render: (criterion) => bpPercent(criterion.weightBp) },
          {
            key: 'proposal',
            header: t('llm.evaluation.column.proposal'),
            align: 'right',
            render: (criterion) =>
              criterion.proposedScore === null ? (
                <StatusPill tone={scoreStatusTone(criterion.status)}>{t('llm.evaluation.withheld', { reason: scoreStatusLabel(t, criterion.status) })}</StatusPill>
              ) : (
                <span data-testid="proposed-score">{criterion.proposedScore}</span>
              ),
          },
          { key: 'citations', header: t('llm.evaluation.column.citations'), render: (criterion) => <CitationList citations={criterion.citations} /> },
        ]}
      />
    </SectionCard>
  );
}

/** The run a person just asked for, shown at once under the form and kept fresh (a decision on it shows here too), with the way to its own page. */
export function CreatedRun({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  const query = useAssistRun(run.id, run);
  const current = query.data ?? run;
  return (
    <SectionCard
      title={t('llm.assist.created.title')}
      actions={
        <Link className="ui-button ui-button--outline ui-button--small" to={`${PATHS.run}?run=${current.id}`} data-testid="open-run">
          {t('llm.assist.created.open')}
        </Link>
      }
    >
      <RunView run={current} />
    </SectionCard>
  );
}
