import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, StatusBadge } from '../components';
import { LIST_PATH, amountText } from '../model';
import { useSummary } from './hooks';
import { statusText } from '../labels';
import { checkLabel, checkState, commandLabel, gateLabel } from './labels';
import { BEFORE_ACTIVATION, checksOf, vietnamToday } from './model';
import type { Command, Summary } from './model';
import { ActivateDialog, NoteDialog, SignDialog } from './WorkspaceDialogs';
import '../ctr.css';

/** The commands in the order of the life of a contract. */
const ORDER: readonly Command[] = ['submit', 'return', 'sign', 'activate', 'cancel'];

type Open = Command | undefined;

/**
 * CTR-03: the workspace of a contract (ST-CTR-004, CTR 3.1 steps 3 to 5). It shows the contract and the people and document behind its signature, what stands before its
 * activation (the bill of quantities, the performance guarantee, the permits, the line of capital and the stage of the project) and the history of its status, and offers the
 * command that applies now: send to review, give back, sign, activate, or cancel the draft. A button is shown only to someone who may press it, which excludes the one who drafted
 * the contract or sent it to review for the commands that approve their work; the server judges every command again, with the delegation limit of the matrix and the
 * conflict of interest.
 */
export default function WorkspaceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The summary and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <WorkspaceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkspaceContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const contractId = search.get('id');
  const summary = useSummary(contractId);
  const [open, setOpen] = useState<Open>(undefined);
  const state = useScreenState({
    isLoading: summary.isLoading,
    error: summary.error,
    data: contractId === null ? null : summary.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const today = vietnamToday(new Date());
  const close = (): void => setOpen(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      {contractId === null ? (
        <>
          <div className="heading">
            <div>
              <h1 id="screen-title">{t('ctr.workspace.page.title')}</h1>
              <p>{t('ctr.workspace.page.subtitle')}</p>
            </div>
          </div>
          <p className="callout" role="status" data-testid="no-contract">
            {t('ctr.workspace.none.notice')} <Link to={LIST_PATH}>{t('ctr.workspace.none.link')}</Link>
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void summary.refetch()}>
          {summary.data === null || summary.data === undefined ? null : (
            <Workspace summary={summary.data} locale={locale} readOnly={mode === 'READ_ONLY'} onOpen={setOpen} />
          )}
        </StateBoundary>
      )}
      {open === undefined || summary.data === null || summary.data === undefined ? null : open === 'sign' ? (
        <SignDialog summary={summary.data} today={today} onClose={close} />
      ) : open === 'activate' ? (
        <ActivateDialog summary={summary.data} today={today} onClose={close} />
      ) : (
        <NoteDialog kind={open === 'return' ? 'return' : open === 'cancel' ? 'cancel' : 'submit'} summary={summary.data} onClose={close} />
      )}
      <p className="prototype-note">{t('ctr.workspace.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface WorkspaceProps {
  summary: Summary;
  locale: string;
  readOnly: boolean;
  onOpen(command: Command): void;
}

function Workspace({ summary, locale, readOnly, onOpen }: WorkspaceProps) {
  const { t } = useTranslation();
  const { contract } = summary;
  const checks = summary.readiness !== undefined && BEFORE_ACTIVATION.includes(contract.status) ? checksOf(summary.readiness) : [];
  const may = (command: Command): boolean => !readOnly && summary.actions?.[command] === true;
  const buttons = ORDER.filter(may);
  const gate = summary.readiness?.permitGate;

  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.workspace.page.title')}</h1>
          <p>
            <strong data-testid="contract-code">{contract.code}</strong> · {contract.title ?? t('ctr.workspace.none.text')} <StatusBadge status={contract.status} />
          </p>
        </div>
        <div className="ctr-row-actions" data-testid="commands">
          {buttons.map((command) => (
            <button key={command} type="button" className={command === 'activate' || command === 'sign' ? 'button primary' : 'button'} data-command={command} onClick={() => onOpen(command)}>
              {commandLabel(t, command)}
            </button>
          ))}
        </div>
      </div>
      {summary.actions !== undefined && buttons.length === 0 ? (
        <p className="callout" role="status" data-testid="no-command">
          {readOnly ? t('ctr.workspace.readOnly.notice') : t('ctr.workspace.noCommand.notice')}
        </p>
      ) : null}
      <div className="ctr-grid">
        <div>
          <article className="card" aria-label={t('ctr.workspace.facts.title')}>
            <h2>{t('ctr.workspace.facts.title')}</h2>
            <dl className="ctr-facts" data-testid="facts">
              <dt>{t('ctr.workspace.fact.project')}</dt>
              <dd>{`${contract.projectCode} · ${contract.projectName}`}</dd>
              <dt>{t('ctr.workspace.fact.contractor')}</dt>
              <dd>{contract.contractorName ?? t('ctr.workspace.none.text')}</dd>
              <dt>{t('ctr.workspace.fact.value')}</dt>
              <dd data-testid="value">{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</dd>
              <dt>{t('ctr.workspace.fact.due')}</dt>
              <dd>{contract.completionDue ?? t('ctr.workspace.none.text')}</dd>
              {summary.signedOn === null ? null : (
                <>
                  <dt>{t('ctr.workspace.fact.signedOn')}</dt>
                  <dd data-testid="signed-on">{summary.signedOn}</dd>
                </>
              )}
              {summary.conflictDecisionRef === null ? null : (
                <>
                  <dt>{t('ctr.workspace.fact.decision')}</dt>
                  <dd data-testid="decision-ref">{summary.conflictDecisionRef}</dd>
                </>
              )}
              {summary.effectiveFrom === null ? null : (
                <>
                  <dt>{t('ctr.workspace.fact.effectiveFrom')}</dt>
                  <dd data-testid="effective-from">{summary.effectiveFrom}</dd>
                </>
              )}
            </dl>
          </article>
          {checks.length === 0 ? null : (
            <article className="card" aria-label={t('ctr.workspace.checks.title')}>
              <h2>{t('ctr.workspace.checks.title')}</h2>
              <ul className="ctr-checks" data-testid="checks">
                {checks.map((check) => (
                  <li key={check.key} data-check={check.key} data-ok={check.ok === undefined ? 'n/a' : String(check.ok)}>
                    <strong>{checkLabel(t, check)}</strong> <span className={check.ok === false ? 'ctr-badge warning' : 'ctr-badge'}>{checkState(t, check)}</span>
                    {check.key === 'permitGate' && gate !== undefined && gate.required ? <span className="sub"> {gateLabel(t, gate.status)}</span> : null}
                    {check.detail.length > 0 && check.key === 'permitGate' ? <span className="sub"> {t('ctr.workspace.check.blocking', { types: check.detail.join(', ') })}</span> : null}
                  </li>
                ))}
              </ul>
            </article>
          )}
        </div>
        <article className="card" aria-label={t('ctr.workspace.history.title')}>
          <h2>{t('ctr.workspace.history.title')}</h2>
          {contract.statusChanges.length === 0 ? (
            <p className="sub" data-testid="no-history">
              {t('ctr.workspace.history.empty')}
            </p>
          ) : (
            <ol className="ctr-history" data-testid="history">
              {contract.statusChanges.map((change) => (
                <li key={change.id} data-from={change.fromStatus} data-to={change.toStatus}>
                  <strong>{t('ctr.workspace.history.move', { from: statusText(t, change.fromStatus), to: statusText(t, change.toStatus) })}</strong> <span className="sub">{change.effectiveOn}</span>
                  <br />
                  <span>{change.reason}</span>
                </li>
              ))}
            </ol>
          )}
        </article>
      </div>
    </>
  );
}
