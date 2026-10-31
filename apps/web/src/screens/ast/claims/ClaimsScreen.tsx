import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../../qms/qms.css';
import './claims.css';
import { AcknowledgeDialog, FileDialog, FixDialog, VerifyDialog } from './ClaimDialogs';
import { useClaims, useObligations } from './hooks';
import { bearerLabel, laneLabel, severityLabel, statusLabel } from './labels';
import { LANES, canFile, laneOf } from './model';
import type { ClaimLine, Lane } from './model';

type T = Translator['t'];
const NONE = '—';

/** A dialog on a claim names the claim, not a copy of it: the claim is read again from the board each time it is drawn, so that a retry after a refusal sends the version the board now shows. */
type Dialog = { kind: 'file' } | { kind: 'acknowledge' | 'fix' | 'verify'; claimId: string };

function severityClass(claim: ClaimLine): string {
  return claim.severity === 'CRITICAL' ? 'pill red' : claim.severity === 'MAJOR' ? 'pill warn' : 'pill gray';
}

/**
 * AST-05: the claims against a warranty and the answer to them (ST-AST-004, AST 3.3, UAT-AC390, UAT-AC391). The board has a column for what nobody has answered, what the contractor took on, what it says is put right, what is disputed
 * and what is verified; each claim shows its severity, the contractor it is addressed to, the day it had to be answered by (and that it is late, with the issue ISS opened for it), the day committed to and who bears the cost. The owner
 * files a claim on an obligation that has not run out; the contractor acknowledges it and says it is put right with evidence; somebody who neither reported the defect nor said it was put right verifies the repair. The server judges
 * every command again.
 */
export default function ClaimsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ClaimsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ClaimsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const may = canFile(permissions, mode);
  const obligations = useObligations(may);
  const wanted = search.get('obligation') ?? '';
  // The board is filtered by what the address asks for, even for an obligation that has run out or is closed and so is no longer offered for a new claim.
  const obligationId = wanted;
  const claims = useClaims(obligationId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: claims.isLoading, error: claims.error, data: claims.data, isEmpty: () => false });
  const lines = claims.data ?? [];
  const choose = (id: string): void => setSearch(id === '' ? {} : { obligation: id });
  // A dialog stays while the claim is still there and the action is still allowed on it; otherwise the board has moved on and the dialog goes.
  const target = dialog === undefined || dialog.kind === 'file' ? undefined : lines.find((line) => line.id === dialog.claimId);
  const open = dialog === undefined ? undefined : dialog.kind === 'file' ? dialog : target !== undefined && target.allowed[dialog.kind] ? { kind: dialog.kind, claim: target } : undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ast.claims.page.title')}</h1>
          <p>{t('ast.claims.page.subtitle')}</p>
        </div>
        {may && (obligations.data ?? []).length > 0 ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'file' })}>
              {t('ast.claims.file.action')}
            </button>
          </div>
        ) : null}
      </div>
      {may && obligations.isError ? (
        <p className="callout warning" role="alert" data-testid="obligations-failed">
          {t('ast.claims.obligations.failed')}{' '}
          <button type="button" onClick={() => void obligations.refetch()}>
            {t('ast.claims.obligations.retry.action')}
          </button>
        </p>
      ) : null}
      {(obligations.data ?? []).length === 0 ? null : (
        <div className="card">
          <div className="field">
            <label htmlFor="claims-filter">{t('ast.claims.filter.obligation')}</label>
            <select id="claims-filter" value={obligationId} onChange={(event) => choose(event.target.value)}>
              <option value="">{t('ast.claims.filter.all')}</option>
              {wanted === '' || (obligations.data ?? []).some((obligation) => obligation.id === wanted) ? null : <option value={wanted}>{t('ast.claims.filter.ended')}</option>}
              {(obligations.data ?? []).map((obligation) => (
                <option key={obligation.id} value={obligation.id}>
                  {`${obligation.contractCode} · ${obligation.handoverNo ?? ''} · ${obligation.scope}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void claims.refetch()}>
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="empty">
            {t('ast.claims.empty.notice')}
          </p>
        ) : (
          <div className="ast-board" data-testid="board">
            {LANES.map((lane) => (
              <LaneColumn key={lane} lane={lane} claims={lines.filter((claim) => laneOf(claim.status) === lane)} onAct={setDialog} />
            ))}
          </div>
        )}
      </StateBoundary>
      {open === undefined ? null : open.kind === 'file' ? (
        <FileDialog obligations={obligations.data ?? []} initialObligationId={obligationId} onClose={() => setDialog(undefined)} />
      ) : open.kind === 'acknowledge' ? (
        <AcknowledgeDialog claim={open.claim} onClose={() => setDialog(undefined)} />
      ) : open.kind === 'fix' ? (
        <FixDialog claim={open.claim} onClose={() => setDialog(undefined)} />
      ) : (
        <VerifyDialog claim={open.claim} onClose={() => setDialog(undefined)} />
      )}
      <p className="prototype-note">{t('ast.claims.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function LaneColumn({ lane, claims, onAct }: { lane: Lane; claims: readonly ClaimLine[]; onAct(dialog: Dialog): void }) {
  const { t } = useTranslation();
  return (
    <section className="ast-lane" data-lane={lane} aria-label={laneLabel(t, lane)}>
      <h2>
        {laneLabel(t, lane)} <span data-testid={`count-${lane}`}>{claims.length}</span>
      </h2>
      {claims.map((claim) => (
        <ClaimCard key={claim.id} claim={claim} onAct={onAct} t={t} />
      ))}
    </section>
  );
}

function ClaimCard({ claim, onAct, t }: { claim: ClaimLine; onAct(dialog: Dialog): void; t: T }) {
  return (
    <article className="card ast-claim" data-claim={claim.id} data-status={claim.status}>
      <h3>
        <code>{claim.claimNo}</code> <span className={severityClass(claim)}>{severityLabel(t, claim.severity)}</span>
      </h3>
      <p>{claim.defect}</p>
      <dl>
        <dt>{t('ast.claims.card.contract')}</dt>
        <dd>{claim.contract.code}</dd>
        <dt>{t('ast.claims.card.contractor')}</dt>
        <dd data-testid="responder">{claim.responder?.name ?? NONE}</dd>
        <dt>{t('ast.claims.card.status')}</dt>
        <dd>{statusLabel(t, claim.status)}</dd>
        <dt>{t('ast.claims.card.due')}</dt>
        <dd data-testid="due">
          {claim.responseDueOn}
          {claim.overdue ? (
            <>
              {' '}
              <span className="pill red" data-testid="overdue">
                {t('ast.claims.card.overdue')}
              </span>
            </>
          ) : null}
        </dd>
        <dt>{t('ast.claims.card.committed')}</dt>
        <dd>{claim.committedFixOn ?? NONE}</dd>
        <dt>{t('ast.claims.card.cost')}</dt>
        <dd data-testid="cost">{bearerLabel(t, claim.costBorneBy)}</dd>
        {claim.evidence.documentId === null && claim.evidence.photoId === null ? null : (
          <>
            <dt>{t('ast.claims.card.evidence')}</dt>
            <dd data-testid="evidence">{[claim.evidence.documentId, claim.evidence.photoId].flatMap((code) => (code === null ? [] : [code])).join(' · ')}</dd>
          </>
        )}
        {claim.fixNote === null ? null : (
          <>
            <dt>{t('ast.claims.card.fix')}</dt>
            <dd data-testid="fix-note">{claim.fixNote}</dd>
          </>
        )}
        {claim.fixEvidence.documentId === null && claim.fixEvidence.photoId === null ? null : (
          <>
            <dt>{t('ast.claims.card.fixEvidence')}</dt>
            <dd data-testid="fix-evidence">{[claim.fixEvidence.documentId, claim.fixEvidence.photoId].flatMap((code) => (code === null ? [] : [code])).join(' · ')}</dd>
          </>
        )}
        {claim.verificationNote === null ? null : (
          <>
            <dt>{t('ast.claims.card.verification')}</dt>
            <dd data-testid="verification-note">{claim.verificationNote}</dd>
          </>
        )}
        {claim.issue === null ? null : (
          <>
            <dt>{t('ast.claims.card.issue')}</dt>
            <dd data-testid="issue">{claim.issue.code}</dd>
          </>
        )}
      </dl>
      <div className="actions">
        {claim.allowed.acknowledge ? (
          <button type="button" data-act="acknowledge" onClick={() => onAct({ kind: 'acknowledge', claimId: claim.id })}>
            {t('ast.claims.act.acknowledge')}
          </button>
        ) : null}
        {claim.allowed.fix ? (
          <button type="button" data-act="fix" onClick={() => onAct({ kind: 'fix', claimId: claim.id })}>
            {t('ast.claims.act.fix')}
          </button>
        ) : null}
        {claim.allowed.verify ? (
          <button type="button" data-act="verify" onClick={() => onAct({ kind: 'verify', claimId: claim.id })}>
            {t('ast.claims.act.verify')}
          </button>
        ) : null}
      </div>
    </article>
  );
}
