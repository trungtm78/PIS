import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { BackLink, FigureInfo, WithInfo } from './components';
import { can, dayText, stampText } from './common';
import { useClaimTerms, useContractChoices } from './hooks';
import { basisLabel, deadlineLabel, effectLabel, sideLabel, termStatusLabel } from './labels';
import { PATHS, TERM_APPROVE_PERMISSION, TERM_PROPOSE_PERMISSION, copyTemplate, emptyTerm, periodsOf } from './model';
import type { ClaimTerm, ClaimTermList, ClaimTermTemplate } from './model';
import { TermDialogs } from './TermDialogs';
import type { TermDialog } from './TermDialogs';
import './claims.css';

type T = Translator['t'];
const NONE = '–';

/**
 * CTR-34, the limitation terms of the claims of one contract (G1-9). A term is what the signed contract says about the time each side has to notify and to detail a claim, with the clause it comes from; one person proposes it and another approves it.
 * Only an approved term gives a claim a limitation clock. The templates of the international forms are examples a person may copy into a proposal: flagged not confirmed, never applied to a contract by themselves.
 */
export default function ClaimTermsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The terms belong to one membership and one contract: a switch of either starts the screen over.
  return <ClaimTermsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('contract') ?? ''}`} route={route} contractId={params.get('contract')} />;
}

function periodsText(t: T, term: Pick<ClaimTerm, 'notice_days' | 'particulars_days' | 'response_days' | 'settlement_days'>): string {
  const periods = periodsOf(term);
  if (periods.length === 0) return NONE;
  return periods.map((period) => t('ctrClaim.terms.period.text', { step: deadlineLabel(t, period.code), days: period.days })).join(' · ');
}

function templatePeriods(t: T, template: ClaimTermTemplate): string {
  return periodsText(t, template);
}

function ClaimTermsContent({ route, contractId }: ScreenProps & { contractId: string | null }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [, setParams] = useSearchParams();
  const contracts = useContractChoices();
  const query = useClaimTerms(contractId);
  const [dialog, setDialog] = useState<TermDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const nonce = useRef(0);
  const data: ClaimTermList | undefined = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const frozen = mode === 'READ_ONLY';
  const canPropose = can(permissions, TERM_PROPOSE_PERMISSION, frozen) && data?.can_propose !== false;
  const canApprove = can(permissions, TERM_APPROVE_PERMISSION, frozen);
  const contract = data?.contract ?? (contractId === null ? undefined : (contracts.data ?? []).find((entry) => entry.id === contractId));
  const openPropose = (template?: ClaimTermTemplate): void => {
    nonce.current += 1;
    setReceipt(undefined);
    setDialog({ kind: 'propose', nonce: nonce.current, form: template === undefined ? emptyTerm() : copyTemplate(emptyTerm(), template) });
  };

  const columns: DataTableColumn<ClaimTerm>[] = [
    { key: 'side', header: t('ctrClaim.terms.column.side.label'), pinned: true, render: (term) => sideLabel(t, term.claimant_side) },
    { key: 'periods', header: t('ctrClaim.terms.column.periods.label'), render: (term) => periodsText(t, term) },
    { key: 'basis', header: t('ctrClaim.terms.column.basis.label'), render: (term) => basisLabel(t, term.basis) },
    { key: 'effect', header: t('ctrClaim.terms.column.effect.label'), render: (term) => effectLabel(t, term.bar_effect) },
    { key: 'clause', header: t('ctrClaim.terms.column.clause.label'), render: (term) => term.clause_reference },
    {
      key: 'status',
      header: t('ctrClaim.terms.column.status.label'),
      render: (term) => (
        <span data-testid="term-status" data-status={term.status}>
          <StatusPill tone={term.status === 'APPROVED' ? 'success' : term.status === 'PROPOSED' ? 'info' : term.status === 'REJECTED' ? 'danger' : 'neutral'}>{termStatusLabel(t, term.status)}</StatusPill>
        </span>
      ),
    },
    { key: 'proposed', header: t('ctrClaim.terms.column.proposed.label'), render: (term) => `${term.proposed_by_name ?? NONE} · ${stampText(term.proposed_at)}` },
    { key: 'decided', header: t('ctrClaim.terms.column.decided.label'), render: (term) => (term.decided_at === null ? NONE : `${term.decided_by_name ?? NONE} · ${stampText(term.decided_at)}`) },
    {
      key: 'actions',
      header: t('ctrClaim.terms.column.actions.label'),
      render: (term) =>
        term.status === 'PROPOSED' && canApprove ? (
          <span className="ctrreg-row-actions">
            <button type="button" className="ui-button ui-button--small ui-button--primary" onClick={() => setDialog({ kind: 'decide', term, decision: 'APPROVE' })} data-testid="term-approve">
              {t('ctrClaim.terms.approve.action')}
            </button>
            <button type="button" className="ui-button ui-button--small ui-button--outline" onClick={() => setDialog({ kind: 'decide', term, decision: 'REJECT' })} data-testid="term-reject">
              {t('ctrClaim.terms.reject.action')}
            </button>
          </span>
        ) : (
          NONE
        ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ctrreg-page">
      <BackLink to={PATHS.register}>{t('ctrClaim.terms.back.action')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctrClaim.terms.page.title')}</h1>
          <p>{t('ctrClaim.terms.page.subtitle')}</p>
        </div>
        {data !== undefined && canPropose && (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => openPropose()} data-testid="propose-button">
              {t('ctrClaim.terms.propose.action')}
            </button>
          </div>
        )}
      </div>
      <label className="ctrreg-filter">
        <span>{t('ctrClaim.terms.contract.label')}</span>
        <select value={contractId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { contract: event.target.value })} data-testid="contract-select">
          <option value="">{t('ctrClaim.terms.pick.option')}</option>
          {(contracts.data ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.code}
            </option>
          ))}
        </select>
      </label>
      {contractId === null ? (
        <div className="card" role="status" data-testid="no-contract">
          <p>{t('ctrClaim.terms.noContract.text')}</p>
        </div>
      ) : (
        <>
          {data !== undefined && <ContextBar items={[{ label: t('ctrClaim.terms.contract.label'), value: data.contract.code }]} stale={query.isError} asOf={stampText(data.as_of)} />}
          {receipt !== undefined && (
            <p className="ctrreg-receipt" role="status" data-testid="receipt">
              {receipt}
            </p>
          )}
          <StateBoundary state={state} onRetry={() => void query.refetch()}>
            {data !== undefined && (
              <>
                <SectionCard title={t('ctrClaim.terms.history.title')}>
                  <DataTable
                    caption={t('ctrClaim.terms.table.caption')}
                    columns={columns}
                    rows={data.items}
                    rowKey={(term) => term.id}
                    rowAttrs={(term) => ({ 'data-term': term.id })}
                    emptyKind="none"
                  />
                  {!data.items.some((term) => term.status === 'APPROVED') && (
                    <p className="ctrreg-notice" role="status" data-testid="no-approved">
                      {t('ctrClaim.terms.noApproved.text')}
                    </p>
                  )}
                </SectionCard>
                <SectionCard title={t('ctrClaim.terms.templates.title')}>
                  <p className="sub">{t('ctrClaim.terms.templates.intro.text')}</p>
                  <ul className="ctrreg-templates" data-testid="templates">
                    {data.templates.map((template) => (
                      <li key={template.code} data-template={template.code}>
                        <strong>{template.code}</strong>
                        <WithInfo
                          info={
                            <FigureInfo
                              name={template.code}
                              formula={t('ctrClaim.terms.templates.formula')}
                              source={t('ctrClaim.terms.templates.source')}
                              asOf={dayText(data.as_of)}
                              rule={template.rule}
                            />
                          }
                        >
                          <span>{`${templatePeriods(t, template)} · ${basisLabel(t, template.basis)} · ${effectLabel(t, template.bar_effect)}`}</span>
                        </WithInfo>
                        <StatusPill tone="warning">{t('ctrClaim.terms.templates.unverified.label')}</StatusPill>
                        {canPropose && (
                          <button type="button" className="ui-button ui-button--small ui-button--outline" onClick={() => openPropose(template)} data-testid={`copy-${template.code}`}>
                            {t('ctrClaim.terms.templates.copy.action')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="sub">
                    <Link to={`${PATHS.register}?contract=${contractId}`}>{t('ctrClaim.terms.toClaims.action')}</Link>
                  </p>
                </SectionCard>
              </>
            )}
          </StateBoundary>
        </>
      )}
      {dialog !== undefined && contract !== undefined && <TermDialogs contract={{ id: contract.id, code: contract.code }} dialog={dialog} onClose={() => setDialog(undefined)} onDone={(text) => { setReceipt(text); setDialog(undefined); }} />}
    </section>
  );
}
