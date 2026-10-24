import { useMemo } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { GateEvaluation } from './GateEvaluation';
import { GateRuleForm } from './GateRuleForm';
import { GateRulesTable } from './GateRulesTable';
import { useGateRules } from './gate-hooks';
import { GATE_MANAGE_PERMISSION } from './gate-model';
import { usePermitTypes } from './hooks';
import { groupTypes, vietnamToday } from './model';
import './pmt.css';

// A tenant without a rule yet still has the form to publish the first and the evaluation to try: that is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/**
 * PMT-04: the gate rules of the permits as dated legal data, and the evaluation of the gates for a project on a day. The business owner publishes the
 * rule of a gate for a permit type with its legal basis, and ends it; everybody who reads permits sees what each gate asks and whether a project passes.
 */
export default function PermitGateScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The evaluation belongs to one membership (the projects it reaches): a switch starts the screen over.
  return <PermitGateContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PermitGateContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const today = vietnamToday();
  const rules = useGateRules();
  const types = usePermitTypes();
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.error, data: rules.data, isEmpty: NEVER_EMPTY });
  const mayManage = (permissions === undefined || permissions.includes(GATE_MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const groups = useMemo(() => groupTypes(types.data ?? [], today).filter((group) => group.current.status !== 'DRAFT'), [types.data, today]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pmt.gate.page.title')}</h1>
          <p>{t('pmt.gate.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void rules.refetch()}>
        <div className="stack">
          {(rules.data ?? []).length === 0 ? (
            <p className="sub" data-testid="empty-rules">
              {t('pmt.gate.empty.text')}
            </p>
          ) : (
            <GateRulesTable rules={rules.data ?? []} today={today} mayRetire={mayManage} />
          )}
          <GateEvaluation />
          {mayManage ? <GateRuleForm today={today} types={groups} rules={rules.data ?? []} /> : <p className="sub">{t('pmt.gate.readonly.text')}</p>}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('pmt.gate.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
