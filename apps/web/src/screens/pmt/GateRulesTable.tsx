import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useRetireGateRule } from './gate-hooks';
import { gateLabel, gateProblemMessage, requirementLabel } from './gate-labels';
import { canRetire, describeGateProblem, rulePhase, rulesByGate, validateRetireDate } from './gate-model';
import type { GateRuleView } from './gate-model';
import { applicabilityText, fieldProblemMessage, phaseLabel } from './labels';
import type { FieldProblem } from './model';

export interface GateRulesTableProps {
  rules: readonly GateRuleView[];
  /** The Vietnam date the phases are judged on. */
  today: string;
  /** Whether the caller may end a rule (and the tenant is not frozen). */
  mayRetire: boolean;
}

const validity = (rule: GateRuleView): string => `${rule.effectiveFrom} → ${rule.effectiveUntil ?? ''}`;

/**
 * PMT-04: the gate rules by gate. A row is a version of the rule of a permit type at a gate, with the legal basis it rests on and the days it
 * applies; the one in force comes first. A rule is never edited: it is ended, and the regulation that replaces it is published as the next
 * revision, so that the evaluation of a past day can always be explained.
 */
export function GateRulesTable({ rules, today, mayRetire }: GateRulesTableProps) {
  const { t } = useTranslation();
  const [retiring, setRetiring] = useState<string | undefined>(undefined);
  return (
    <>
      {rulesByGate(rules, today).map((group) => (
        <div className="card" key={group.gateCode} data-gate={group.gateCode}>
          <h2>{gateLabel(t, group.gateCode)}</h2>
          <table className="table" aria-label={t('pmt.gate.table.aria', { gate: gateLabel(t, group.gateCode) })}>
            <thead>
              <tr>
                <th scope="col">{t('pmt.gate.column.type')}</th>
                <th scope="col">{t('pmt.gate.column.milestone')}</th>
                <th scope="col">{t('pmt.gate.column.requirement')}</th>
                <th scope="col">{t('pmt.gate.column.applies')}</th>
                <th scope="col">{t('pmt.gate.column.validity')}</th>
                <th scope="col">{t('pmt.gate.column.basis')}</th>
                <th scope="col">
                  <span className="sr-only">{t('pmt.gate.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {group.rules.map((rule) => (
                <RuleRow key={rule.id} rule={rule} today={today} mayRetire={mayRetire} open={retiring === rule.id} onOpen={() => setRetiring(rule.id)} onClose={() => setRetiring(undefined)} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

interface RuleRowProps {
  rule: GateRuleView;
  today: string;
  mayRetire: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

function RuleRow({ rule, today, mayRetire, open, onOpen, onClose }: RuleRowProps) {
  const { t } = useTranslation();
  const phase = rulePhase(rule, today);
  return (
    <>
      <tr data-rule-id={rule.id} data-phase={phase} data-gate={rule.gateCode}>
        <th scope="row">
          <code>{rule.permitTypeCode}</code> <small className="sub">{t('pmt.gate.revision.text', { revision: rule.revision })}</small>
        </th>
        <td>{rule.milestoneCode ?? ''}</td>
        <td>{requirementLabel(t, rule.requirement)}</td>
        <td>{applicabilityText(t, rule.appliesTo)}</td>
        <td>
          {validity(rule)} <span className={phase === 'inForce' ? 'pill' : 'pill gray'}>{phaseLabel(t, phase)}</span>
        </td>
        <td>{rule.legalBasis}</td>
        <td className="row-actions">
          {mayRetire && canRetire(rule, today) ? (
            <button type="button" onClick={onOpen} aria-expanded={open}>
              {t('pmt.gate.retire.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr data-retire-for={rule.id}>
          <td colSpan={7}>
            <RetireForm rule={rule} today={today} onClose={onClose} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RetireForm({ rule, today, onClose }: { rule: GateRuleView; today: string; onClose: () => void }) {
  const { t } = useTranslation();
  const retire = useRetireGateRule();
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refused = retire.isError ? describeGateProblem(retire.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (retire.isPending) return;
    const found = validateRetireDate(until, rule, today);
    setProblem(found);
    if (found === undefined) retire.mutate({ id: rule.id, effectiveUntil: until }, { onSuccess: onClose });
  };
  return (
    <form className="cap-form" onSubmit={submit} noValidate aria-label={t('pmt.gate.retire.title', { code: rule.permitTypeCode })}>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="retire-problem">
          {gateProblemMessage(t, refused)}
        </p>
      )}
      <Field id={`retire-until-${rule.id}`} label={t('pmt.gate.retire.until.label')} hint={t('pmt.gate.retire.until.hint')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)}>
        <input
          id={`retire-until-${rule.id}`}
          type="date"
          value={until}
          onChange={(event) => {
            setUntil(event.target.value);
            setProblem(undefined);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={retire.isPending}>
          {retire.isPending ? t('pmt.gate.retire.pending') : t('pmt.gate.retire.confirm')}
        </button>
        <button type="button" onClick={onClose}>
          {t('pmt.gate.retire.cancel')}
        </button>
      </div>
    </form>
  );
}
