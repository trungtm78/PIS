import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ConfirmDialog } from '../../ui';
import { useMemberOptions } from '../dir/hooks';
import { refusalText, roleLabelOf } from './components';
import { useAppoint, useEndMember, useRegister } from './hooks';
import { END_REASON_MIN, REGISTER_CODE, ROLES, appointBody, appointProblems, vietnamDay } from './model';
import type { AppointInput, Member, MemberRole } from './model';

/** Registers a committee: its code (capitals, digits and underscore), its name and the legal basis it stands on. */
export function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const register = useRegister();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [legalBasis, setLegalBasis] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const codeBad = !REGISTER_CODE.test(code.trim());
  const nameBad = name.trim() === '';
  return (
    <ConfirmDialog
      open
      title={t('ban.ros.register.title')}
      context={[]}
      confirmLabel={t('ban.ros.register.confirm')}
      cancelLabel={t('ban.att.dialog.cancel')}
      pending={register.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        setTried(true);
        if (codeBad || nameBad) {
          setError(t('ban.ros.register.invalid.text'));
          return;
        }
        setError(undefined);
        register.mutate({ code, name, legalBasis }, { onSuccess: () => onDone(t('ban.ros.register.receipt', { code: code.trim() })), onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <div className="ban-form" data-testid="register-form">
        <label htmlFor="ban-reg-code">
          <span>{t('ban.ros.register.code')}</span>
          <input id="ban-reg-code" type="text" maxLength={40} value={code} data-testid="register-code" onChange={(event) => setCode(event.target.value)} />
          {tried && codeBad ? <span className="ban-error">{t('ban.ros.register.code.error')}</span> : null}
        </label>
        <label htmlFor="ban-reg-name">
          <span>{t('ban.ros.register.name')}</span>
          <input id="ban-reg-name" type="text" maxLength={300} value={name} data-testid="register-name" onChange={(event) => setName(event.target.value)} />
          {tried && nameBad ? <span className="ban-error">{t('ban.ros.register.name.error')}</span> : null}
        </label>
        <label className="ban-wide" htmlFor="ban-reg-basis">
          <span>{t('ban.ros.register.basis')}</span>
          <input id="ban-reg-basis" type="text" maxLength={500} value={legalBasis} data-testid="register-basis" onChange={(event) => setLegalBasis(event.target.value)} />
        </label>
      </div>
    </ConfirmDialog>
  );
}

/** Appoints a person to a place of the committee: the decision that appoints them, the days, the agency, and whether a second factor is required of them. Nobody appoints themselves; the server says so. */
export function AppointDialog({ committeeId, committeeName, onClose, onDone }: { committeeId: string; committeeName: string; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const appoint = useAppoint();
  const people = useMemberOptions();
  const [membershipId, setMembershipId] = useState('');
  const [role, setRole] = useState<MemberRole>('MEMBER');
  const [agencyCode, setAgencyCode] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [decisionRef, setDecisionRef] = useState('');
  const [validFrom, setValidFrom] = useState(vietnamDay());
  const [validUntil, setValidUntil] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const input: AppointInput = { committeeId, membershipId, role, agencyCode, agencyName, decisionRef, validFrom, validUntil, mfaRequired };
  const problems = appointProblems(input);
  const shown = (problem: (typeof problems)[number]): boolean => tried && problems.includes(problem);
  return (
    <ConfirmDialog
      open
      title={t('ban.ros.appoint.title')}
      context={[{ label: t('ban.ros.committee.label'), value: committeeName }]}
      confirmLabel={t('ban.ros.appoint.confirm')}
      cancelLabel={t('ban.att.dialog.cancel')}
      pending={appoint.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        setTried(true);
        if (problems.length > 0) {
          setError(t('ban.ros.appoint.invalid.text'));
          return;
        }
        setError(undefined);
        appoint.mutate({ body: appointBody(input) }, { onSuccess: () => onDone(t('ban.ros.appoint.receipt')), onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <div className="ban-form" data-testid="appoint-form">
        <label className="ban-wide" htmlFor="ban-app-person">
          <span>{t('ban.ros.appoint.person')}</span>
          <select id="ban-app-person" value={membershipId} data-testid="appoint-person" onChange={(event) => setMembershipId(event.target.value)}>
            <option value="">{t('ban.ros.appoint.choose')}</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
          </select>
          {people.isError ? <span className="ban-error">{t('ban.ros.appoint.people.error')}</span> : null}
          {shown('membership') ? <span className="ban-error">{t('ban.ros.appoint.person.error')}</span> : null}
        </label>
        <label htmlFor="ban-app-role">
          <span>{t('ban.ros.appoint.role')}</span>
          <select id="ban-app-role" value={role} data-testid="appoint-role" onChange={(event) => setRole(ROLES.find((one) => one === event.target.value) ?? 'MEMBER')}>
            {ROLES.map((one) => (
              <option key={one} value={one}>
                {roleLabelOf(t, one)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="ban-app-agency-code">
          <span>{t('ban.ros.appoint.agencyCode')}</span>
          <input id="ban-app-agency-code" type="text" maxLength={40} value={agencyCode} data-testid="appoint-agency-code" onChange={(event) => setAgencyCode(event.target.value)} />
          {shown('agencyCode') ? <span className="ban-error">{t('ban.ros.appoint.agencyCode.error')}</span> : null}
        </label>
        <label htmlFor="ban-app-agency-name">
          <span>{t('ban.ros.appoint.agencyName')}</span>
          <input id="ban-app-agency-name" type="text" maxLength={300} value={agencyName} onChange={(event) => setAgencyName(event.target.value)} />
        </label>
        <label className="ban-wide" htmlFor="ban-app-decision">
          <span>{t('ban.ros.appoint.decision')}</span>
          <input id="ban-app-decision" type="text" maxLength={300} value={decisionRef} data-testid="appoint-decision" onChange={(event) => setDecisionRef(event.target.value)} />
        </label>
        <label htmlFor="ban-app-from">
          <span>{t('ban.ros.appoint.from')}</span>
          <input id="ban-app-from" type="date" value={validFrom} data-testid="appoint-from" onChange={(event) => setValidFrom(event.target.value)} />
          {shown('validFrom') ? <span className="ban-error">{t('ban.ros.appoint.from.error')}</span> : null}
        </label>
        <label htmlFor="ban-app-until">
          <span>{t('ban.ros.appoint.until')}</span>
          <input id="ban-app-until" type="date" value={validUntil} data-testid="appoint-until" onChange={(event) => setValidUntil(event.target.value)} />
          {shown('validUntil') ? <span className="ban-error">{t('ban.ros.appoint.until.error')}</span> : null}
        </label>
        <label className="ban-wide" htmlFor="ban-app-mfa">
          <span>
            <input id="ban-app-mfa" type="checkbox" checked={mfaRequired} data-testid="appoint-mfa" onChange={(event) => setMfaRequired(event.target.checked)} /> {t('ban.ros.appoint.mfa')}
          </span>
        </label>
      </div>
    </ConfirmDialog>
  );
}

/** Ends a place: it says why (at least a few words), the place is kept and never removed, and it cannot be opened again. A place that changed in the meantime is refused with its version. */
export function EndDialog({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const end = useEndMember();
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('ban.ros.end.title')}
      context={[
        { label: t('ban.ros.col.person'), value: member.display_name ?? member.membership_id },
        { label: t('ban.ros.col.role'), value: roleLabelOf(t, member.committee_role) },
      ]}
      confirmLabel={t('ban.ros.end.confirm')}
      cancelLabel={t('ban.att.dialog.cancel')}
      pending={end.isPending}
      reason={{ label: t('ban.ros.end.reason'), required: true, minLength: END_REASON_MIN, hint: t('ban.ros.end.hint', { count: END_REASON_MIN }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) =>
        end.mutate({ memberId: member.id, version: member.version, reason: reason ?? '' }, { onSuccess: () => onDone(t('ban.ros.end.receipt')), onError: (failure) => setError(refusalText(t, failure)) })
      }
    >
      <p>{t('ban.ros.end.text')}</p>
    </ConfirmDialog>
  );
}
