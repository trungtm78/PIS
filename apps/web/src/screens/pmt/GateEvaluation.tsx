import { useState } from 'react';
import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import { Field, Pill } from './components';
import { SectionCard } from '../../ui';
import { useProjectOptions } from './dossier-commands';
import { useGateEvaluation } from './gate-hooks';
import { gateLabel, outcomeLabel, requirementLabel, statusLabel } from './gate-labels';
import { GATE_CODES, asOfOf } from './gate-model';
import type { GateCode, GateView, VerdictView } from './gate-model';
import { permitLink } from './dossier-model';
import { Link } from 'react-router-dom';

/**
 * The evaluation of the gates for a project on a day (PMT-04): whether each gate passes, passes with a waiver or is blocked, and for each rule judged
 * the legal basis and the permit or waiver that satisfies it. It is the answer the commands of CTR, QMS, PRJ, AST and PAY get before they act.
 */
export function GateEvaluation() {
  const { t } = useTranslation();
  const projects = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [gate, setGate] = useState<GateCode | ''>('');
  const [day, setDay] = useState('');
  const asOf = asOfOf(day);
  const chosen = projectId !== '' ? projectId : projects.data?.[0]?.id;
  const evaluation = useGateEvaluation(chosen, gate === '' ? undefined : gate, asOf.valid ? asOf.at : undefined);
  const missing = evaluation.error instanceof ApiError && evaluation.error.status === 404;

  return (
    <div data-testid="evaluation">
      <SectionCard title={t('pmt.gate.eval.title')}>
      <p className="sub">{t('pmt.gate.eval.hint')}</p>
      <div className="cap-filters">
        <Field id="eval-project" label={t('pmt.gate.eval.project.label')} error={undefined}>
          <select id="eval-project" value={chosen ?? ''} onChange={(event) => setProjectId(event.target.value)}>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="eval-gate" label={t('pmt.gate.eval.gate.label')} error={undefined}>
          <select id="eval-gate" value={gate} onChange={(event) => setGate(event.target.value as GateCode | '')}>
            <option value="">{t('pmt.gate.eval.gate.all')}</option>
            {GATE_CODES.map((code) => (
              <option key={code} value={code}>
                {gateLabel(t, code)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="eval-day" label={t('pmt.gate.eval.day.label')} hint={t('pmt.gate.eval.day.hint')} error={asOf.valid ? undefined : t('pmt.field.invalidDate.error')}>
          <input id="eval-day" type="date" value={day} aria-invalid={!asOf.valid} onChange={(event) => setDay(event.target.value)} />
        </Field>
      </div>
      {chosen === undefined ? (
        <p className="sub" data-testid="eval-no-project">
          {t('pmt.gate.eval.noProject.text')}
        </p>
      ) : missing ? (
        <p className="callout warning" role="status" data-testid="eval-missing">
          {t('pmt.gate.problem.notFound.error')}
        </p>
      ) : evaluation.isError ? (
        <p className="callout warning" role="alert" data-testid="eval-error">
          {t('pmt.gate.problem.general.error')}
        </p>
      ) : evaluation.data === undefined ? null : (
        <div className="stack" data-testid="eval-result" data-as-of={evaluation.data.asOf}>
          {evaluation.data.gates.map((view) => (
            <GateResult key={view.gateCode} view={view} />
          ))}
        </div>
      )}
      </SectionCard>
    </div>
  );
}

function GateResult({ view }: { view: GateView }) {
  const { t } = useTranslation();
  return (
    <section data-gate-result={view.gateCode} data-status={view.status} aria-label={gateLabel(t, view.gateCode)}>
      <h3>
        {gateLabel(t, view.gateCode)} <Pill tone={view.status === 'BLOCKED' ? 'warning' : 'success'}>{statusLabel(t, view.status)}</Pill>
      </h3>
      {view.rules.length === 0 ? (
        <p className="sub">{t('pmt.gate.eval.noRules.text')}</p>
      ) : (
        <ul>
          {view.rules.map((verdict) => (
            <VerdictLine key={verdict.ruleId} verdict={verdict} />
          ))}
        </ul>
      )}
    </section>
  );
}

function VerdictLine({ verdict }: { verdict: VerdictView }) {
  const { t } = useTranslation();
  return (
    <li data-outcome={verdict.outcome} data-rule-id={verdict.ruleId}>
      <strong>{verdict.permitTypeCode}</strong> · {requirementLabel(t, verdict.requirement)} · {outcomeLabel(t, verdict.outcome)}
      {verdict.permit === null ? null : (
        <>
          {' '}
          <Link to={permitLink(verdict.permit.id)}>{t('pmt.gate.eval.permit.text', { no: verdict.permit.permitNo ?? verdict.permit.status })}</Link>
        </>
      )}
      {verdict.waiver === null ? null : <> {t('pmt.gate.eval.waiver.text', { date: verdict.waiver.validUntil })}</>}
      <br />
      <small className="sub">{t('pmt.gate.eval.basis.text', { basis: verdict.legalBasis, revision: verdict.revision })}</small>
    </li>
  );
}
