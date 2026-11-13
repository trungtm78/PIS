import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { ScrollRegion } from '../scroll-region';
import { Field, Pill } from './components';
import { gateLabel } from './gate-labels';
import { useRevokeWaiver } from './waiver-hooks';
import { phaseLabel, waiverProblemMessage, waiverStatusLabel } from './waiver-labels';
import { daysLeft, describeWaiverProblem, phaseOf, validateRevoke } from './waiver-model';
import type { RevokeProblem, WaiverView } from './waiver-model';

export interface WaiversTableProps {
  waivers: readonly WaiverView[];
  /** The Vietnam date the phases are judged on. */
  today: string;
  /** Whether the caller may revoke a waiver (and the tenant is not frozen). */
  mayRevoke: boolean;
  /** What the one row of an empty table says. */
  empty: string;
}

/**
 * PMT-06: the waivers of the gates. A row is one decision: the project, the gate, the permit type it lets through, the reason and the last day. A waiver
 * is never extended or edited: it ends by its last day or by a revocation that gives its words, and a new decision is a new waiver.
 */
export function WaiversTable({ waivers, today, mayRevoke, empty }: WaiversTableProps) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState<string | undefined>(undefined);
  return (
    <ScrollRegion label={t('pmt.waiver.table.aria')}>
      <table className="table" data-testid="waivers" aria-label={t('pmt.waiver.table.aria')}>
        <thead>
          <tr>
            <th scope="col">{t('pmt.waiver.column.project')}</th>
            <th scope="col">{t('pmt.waiver.column.gate')}</th>
            <th scope="col">{t('pmt.waiver.column.type')}</th>
            <th scope="col">{t('scr2.pmt.waiver.column.basis')}</th>
            <th scope="col">{t('scr2.pmt.waiver.column.document')}</th>
            <th scope="col">{t('scr2.pmt.waiver.column.approver')}</th>
            <th scope="col">{t('scr2.pmt.waiver.column.until')}</th>
            <th scope="col">{t('pmt.waiver.column.status')}</th>
            <th scope="col">
              <span className="sr-only">{t('pmt.waiver.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {waivers.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS} className="sub" data-testid="empty-waivers">
                {empty}
              </td>
            </tr>
          ) : null}
          {waivers.map((waiver) => (
            <WaiverRow key={waiver.id} waiver={waiver} today={today} mayRevoke={mayRevoke} open={revoking === waiver.id} onOpen={() => setRevoking(waiver.id)} onClose={() => setRevoking(undefined)} />
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/** The columns of the table, for the rows that span it. */
const COLUMNS = 9;

interface WaiverRowProps {
  waiver: WaiverView;
  today: string;
  mayRevoke: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

function WaiverRow({ waiver, today, mayRevoke, open, onOpen, onClose }: WaiverRowProps) {
  const { t } = useTranslation();
  const phase = phaseOf(waiver, today);
  const days = daysLeft(waiver, today);
  return (
    <>
      <tr data-waiver-id={waiver.id} data-phase={phase} data-status={waiver.status} data-gate={waiver.gateCode}>
        <th scope="row">
          {waiver.projectCode}
          <br />
          <small className="sub">{waiver.projectName}</small>
        </th>
        <td>{gateLabel(t, waiver.gateCode)}</td>
        <td>
          <code>{waiver.permitTypeCode}</code>
          <br />
          <small className="sub">{waiver.permitTypeName}</small>
        </td>
        <td>
          <span className="sub">{t('pmt.waiver.column.reason')}:</span> {waiver.reason}
          {waiver.revokedReason === null ? null : (
            <>
              <br />
              <small className="sub">{t('pmt.waiver.revoked.text', { date: waiver.revokedOn ?? '', reason: waiver.revokedReason })}</small>
            </>
          )}
        </td>
        <td>
          <code data-testid="decision-document" title={waiver.decisionDocumentVersionId}>
            {waiver.decisionDocumentVersionId.slice(0, 8)}
          </code>
          <br />
          <small className="sub">{t('scr2.pmt.waiver.grantedOn', { date: waiver.grantedOn })}</small>
        </td>
        <td>
          <small className="sub" data-testid="approver">
            {t('scr2.pmt.waiver.approver.audit')}
          </small>
        </td>
        <td>
          <span className="sub">{t('pmt.waiver.column.until')}:</span> {waiver.validUntil}
          {phase === 'inForce' ? (
            <>
              <br />
              <small className="sub" data-testid="days-left">
                {days === 0 ? t('pmt.waiver.left.today.text') : t('pmt.waiver.left.days.text', { days })}
              </small>
            </>
          ) : null}
        </td>
        <td>
          <Pill tone={phase === 'inForce' ? 'success' : 'gray'}>{phaseLabel(t, phase)}</Pill>
          <br />
          <small className="sub">{waiverStatusLabel(t, waiver.status)}</small>
        </td>
        <td className="row-actions">
          {mayRevoke && phase === 'inForce' ? (
            <button type="button" onClick={onOpen} aria-expanded={open}>
              {t('pmt.waiver.revoke.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr data-revoke-for={waiver.id}>
          <td colSpan={COLUMNS}>
            <RevokeForm waiver={waiver} onClose={onClose} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RevokeForm({ waiver, onClose }: { waiver: WaiverView; onClose: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokeWaiver();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<RevokeProblem | undefined>(undefined);
  const refused = revoke.isError ? describeWaiverProblem(revoke.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (revoke.isPending) return;
    const found = validateRevoke(reason);
    setProblem(found);
    if (found === undefined) revoke.mutate({ id: waiver.id, reason }, { onSuccess: onClose });
  };
  return (
    <form className="cap-form" onSubmit={submit} noValidate aria-label={t('pmt.waiver.revoke.title', { code: waiver.permitTypeCode })}>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="revoke-problem">
          {waiverProblemMessage(t, refused)}
        </p>
      )}
      <Field
        id={`revoke-reason-${waiver.id}`}
        label={t('pmt.waiver.revoke.reason.label')}
        hint={t('pmt.waiver.revoke.reason.hint')}
        error={problem === undefined ? undefined : problem === 'required' ? t('pmt.waiver.field.required.error') : t('pmt.waiver.field.tooLong.error')}
      >
        <textarea
          id={`revoke-reason-${waiver.id}`}
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setProblem(undefined);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={revoke.isPending}>
          {revoke.isPending ? t('pmt.waiver.revoke.pending') : t('pmt.waiver.revoke.confirm')}
        </button>
        <button type="button" onClick={onClose}>
          {t('pmt.waiver.revoke.cancel')}
        </button>
      </div>
    </form>
  );
}
