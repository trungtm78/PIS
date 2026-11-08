import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { useGateCheck } from '../shared/vnd-hooks';
import {
  basisLabel,
  behaviourLabel,
  caseStatusLabel,
  eventStatusLabel,
  gateActionLabel,
  gateCheckLabel,
  groupLabel,
  ownerKindLabel,
  profileFieldLabel,
  refusalLabel,
  signalLabel,
  suggestionLabel,
  taxChecksumLabel,
  taxFormatLabel,
  verificationLabel,
  ventureStatusLabel,
  duplicateStatusLabel,
  warningLabel,
} from '../shared/vnd-labels';
import { GATE_ACTIONS, PATHS, PROFILE_FIELDS, caseStatusTone, dayText, numberText, paramNumber, vietnamStamp, verificationTone } from '../shared/vnd-model';
import type { CaseLine, Duplicate, GateAction, Owner, ProfileView, ReputationEvent, RestrictionLine, Venture } from '../shared/vnd-model';
import { ClockCell, CoverageBar, CountInfo, Empty, Fact, PolicyInfo, UnverifiedPill } from '../shared/vnd-ui';

const NONE = '–';
const orNone = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

// ---- the profile --------------------------------------------------------------------------------------------------------------------------------------------------------------

function ownershipText(t: ReturnType<typeof useTranslation>['t'], declaration: ProfileView['profile']['ownership_declaration']): string {
  switch (declaration) {
    case 'OWNERS_LISTED':
      return t('vnd.profile.ownership.listed.text');
    case 'NO_OWNER_ABOVE_THRESHOLD':
      return t('vnd.profile.ownership.none.text');
    default:
      return t('vnd.profile.ownership.missing.text');
  }
}

export function IdentityTab({ view, canEdit, onEdit }: { view: ProfileView; canEdit: boolean; onEdit: () => void }) {
  const { t, locale } = useTranslation();
  const profile = view.profile;
  const check = view.tax_check;
  const formatOk = check.format === 'VALID';
  const checksumTone = check.checksum === 'MATCH' ? 'success' : check.checksum === 'MISMATCH' ? 'danger' : 'neutral';
  return (
    <div className="vnd-page">
      <SectionCard
        title={t('vnd.profile.section.identity.title')}
        status={<StatusPill tone={verificationTone(profile.verification_status)}>{verificationLabel(t, profile.verification_status)}</StatusPill>}
        actions={
          canEdit ? (
            <button type="button" className="ui-button ui-button--outline" data-testid="edit-profile" onClick={onEdit}>
              {t('vnd.profile.edit.action')}
            </button>
          ) : undefined
        }
      >
        <dl className="vnd-facts" data-testid="profile-facts">
          <Fact label={t('vnd.profile.fact.name.label')} testId="fact-name">
            {profile.legal_name}
          </Fact>
          <Fact label={t('vnd.profile.fact.tax.label')} testId="fact-tax">
            <code>{profile.tax_identifier}</code>
          </Fact>
          <Fact label={t('vnd.profile.fact.legalRep.label')} testId="fact-legal-rep">
            {orNone(profile.legal_rep_name)}
            {profile.legal_rep_position !== null && ` · ${profile.legal_rep_position}`}
          </Fact>
          <Fact label={t('vnd.profile.fact.address.label')} testId="fact-address">
            {orNone(profile.registered_address)}
          </Fact>
          <Fact label={t('vnd.profile.fact.phone.label')} testId="fact-phone">
            {orNone(profile.phone)}
            {profile.phone_set_at !== null && <span className="vnd-days"> {t('vnd.profile.fact.phoneSet.text', { time: vietnamStamp(profile.phone_set_at) })}</span>}
          </Fact>
          <Fact label={t('vnd.profile.fact.email.label')} testId="fact-email">
            {orNone(profile.email)}
          </Fact>
          <Fact label={t('vnd.profile.fact.registration.label')} testId="fact-registration">
            {orNone(profile.business_registration_no)}
          </Fact>
          <Fact label={t('vnd.profile.fact.ownership.label')} testId="fact-ownership">
            {ownershipText(t, profile.ownership_declaration)} <span className="vnd-days">{t('vnd.profile.fact.ownerCount.text', { count: numberText(profile.owner_count, locale) })}</span>
          </Fact>
          <Fact label={t('vnd.profile.fact.review.label')} testId="fact-review">
            {profile.next_review_due === null ? NONE : dayText(profile.next_review_due)}
            {profile.profile_reviewed_at !== null && <span className="vnd-days"> {t('vnd.profile.fact.reviewed.text', { time: vietnamStamp(profile.profile_reviewed_at) })}</span>}
          </Fact>
        </dl>
      </SectionCard>
      <div className="vnd-cols">
        <SectionCard title={t('vnd.profile.section.coverage.title')} status={view.policies.profile.unverified ? <UnverifiedPill /> : undefined}>
          <p className="vnd-row" data-testid="coverage-line">
            <CoverageBar coverage={view.coverage} label={t('vnd.profile.coverage.label')} />
            <PolicyInfo name={t('vnd.profile.figure.coverage.name')} policy={view.policies.profile} />
          </p>
          <ul className="vnd-badges vnd-list" data-testid="coverage-fields">
            {PROFILE_FIELDS.filter((field) => view.coverage.required.includes(field) || view.coverage.present.includes(field)).map((field) => (
              <li key={field}>
                <StatusPill tone={view.coverage.present.includes(field) ? 'success' : 'warning'} icon={view.coverage.present.includes(field) ? '✓' : '○'}>
                  {profileFieldLabel(t, field)}
                </StatusPill>
              </li>
            ))}
          </ul>
          <p className="vnd-note">{view.coverage.complete ? t('vnd.profile.coverage.complete.text') : t('vnd.profile.coverage.incomplete.text')}</p>
        </SectionCard>
        <SectionCard title={t('vnd.profile.section.tax.title')} status={check.checksum_legal_status === 'UNVERIFIED' ? <UnverifiedPill /> : undefined}>
          <dl className="vnd-facts" data-testid="tax-check">
            <Fact label={t('vnd.profile.tax.format.label')} testId="tax-format">
              <StatusPill tone={formatOk ? 'success' : 'danger'} icon={formatOk ? '✓' : '⛔'}>
                {taxFormatLabel(t, check.format)}
              </StatusPill>
            </Fact>
            <Fact label={t('vnd.profile.tax.checksum.label')} testId="tax-checksum">
              <span className="vnd-row">
                <StatusPill tone={checksumTone}>{taxChecksumLabel(t, check.checksum)}</StatusPill>
                <CountInfo
                  name={t('vnd.profile.figure.tax.name')}
                  formula={t('vnd.profile.figure.tax.formula')}
                  source={t('vnd.profile.figure.tax.source')}
                  asOf={view.as_of}
                  unverified={check.checksum_legal_status === 'UNVERIFIED'}
                />
              </span>
            </Fact>
            <Fact label={t('vnd.profile.tax.normalised.label')} testId="tax-normalised">
              {orNone(check.normalised)}
            </Fact>
          </dl>
          {check.checksum_legal_status === 'UNVERIFIED' && <p className="vnd-note">{t('vnd.profile.tax.unverified.text')}</p>}
        </SectionCard>
      </div>
      <SectionCard title={t('vnd.profile.section.links.title')}>
        <ul className="vnd-list">
          <li>
            <Link to={PATHS.payee(profile.contractor_id)}>{t('vnd.profile.links.payee.text', { count: numberText(view.accounts.length, locale), changes: numberText(view.payee_changes.length, locale) })}</Link>
          </li>
          <li>
            <Link to={PATHS.certificates(profile.contractor_id)}>
              {t('vnd.profile.links.certificates.text', { qualifications: numberText(view.qualifications.length, locale), staff: numberText(view.key_staff.length, locale) })}
            </Link>
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

// ---- owners -------------------------------------------------------------------------------------------------------------------------------------------------------------------

export function OwnersTab({ view, canManage, onAdd, onEnd, onDeclare }: { view: ProfileView; canManage: boolean; onAdd: () => void; onEnd: (owner: Owner) => void; onDeclare: () => void }) {
  const { t, locale } = useTranslation();
  const threshold = paramNumber(view.policies.profile, 'beneficial_owner_pct');
  return (
    <SectionCard
      title={t('vnd.owners.section.title')}
      status={view.policies.profile.unverified ? <UnverifiedPill /> : undefined}
      actions={
        canManage ? (
          <>
            <button type="button" className="ui-button ui-button--outline" data-testid="declare-no-owner" onClick={onDeclare}>
              {t('vnd.owners.declare.action')}
            </button>
            <button type="button" className="ui-button ui-button--primary" data-testid="add-owner" onClick={onAdd}>
              {t('vnd.owners.add.action')}
            </button>
          </>
        ) : undefined
      }
    >
      <p className="vnd-note vnd-row" data-testid="owners-rule">
        <span>{threshold === undefined ? t('vnd.owners.rule.plain.text') : t('vnd.owners.rule.text', { pct: numberText(threshold, locale) })}</span>
        <PolicyInfo name={t('vnd.owners.figure.threshold.name')} policy={view.policies.profile} />
      </p>
      <p className="vnd-note" data-testid="owners-declaration">
        {ownershipText(t, view.profile.ownership_declaration)}
      </p>
      {view.owners.length === 0 ? (
        <Empty text={t('vnd.owners.empty.text')} testId="owners-empty" />
      ) : (
        <DataTable<Owner>
          caption={t('vnd.owners.table.caption')}
          rows={view.owners}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-owner-id': row.id })}
          columns={[
            { key: 'name', header: t('vnd.owners.column.name'), pinned: true, render: (row) => <span>{row.owner_name}</span> },
            { key: 'kind', header: t('vnd.owners.column.kind'), render: (row) => ownerKindLabel(t, row.owner_kind) },
            { key: 'share', header: t('vnd.owners.column.share'), align: 'right', render: (row) => (row.share_pct === null ? NONE : `${row.share_pct}%`) },
            {
              key: 'beneficial',
              header: t('vnd.owners.column.beneficial'),
              render: (row) => (
                <span className="vnd-stack">
                  <StatusPill tone={row.beneficial_owner ? 'info' : 'neutral'}>{row.beneficial_owner ? t('vnd.owners.beneficial.yes') : t('vnd.owners.beneficial.no')}</StatusPill>
                  {row.control_basis !== null && <span className="vnd-days">{basisLabel(t, row.control_basis)}</span>}
                </span>
              ),
            },
            { key: 'identity', header: t('vnd.owners.column.identity'), render: (row) => (row.has_identity_key ? t('vnd.owners.identity.yes') : t('vnd.owners.identity.no')) },
            { key: 'since', header: t('vnd.owners.column.since'), render: (row) => dayText(row.since_on) },
            {
              key: 'ended',
              header: t('vnd.owners.column.ended'),
              render: (row) =>
                row.ended_on === null ? (
                  <StatusPill tone="success">{t('vnd.owners.status.current')}</StatusPill>
                ) : (
                  <span className="vnd-stack">
                    <StatusPill tone="neutral">{t('vnd.owners.status.ended', { day: dayText(row.ended_on) })}</StatusPill>
                    {row.ended_reason !== null && <span className="vnd-days">{row.ended_reason}</span>}
                  </span>
                ),
            },
            {
              key: 'actions',
              header: t('vnd.owners.column.actions'),
              render: (row) =>
                canManage && row.ended_on === null ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="end-owner" onClick={() => onEnd(row)}>
                    {t('vnd.owners.end.action')}
                  </button>
                ) : null,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- duplicates -------------------------------------------------------------------------------------------------------------------------------------------------------------

export function DuplicatesTab({
  view,
  canDecide,
  canScan,
  scanning,
  onScan,
  onDecide,
}: {
  view: ProfileView;
  canDecide: boolean;
  canScan: boolean;
  scanning: boolean;
  onScan: () => void;
  onDecide: (duplicate: Duplicate, decision: 'DISMISSED' | 'MERGE_REQUESTED') => void;
}) {
  const { t, locale } = useTranslation();
  return (
    <SectionCard
      title={t('vnd.duplicates.section.title')}
      status={<UnverifiedPill />}
      actions={
        canScan ? (
          <button type="button" className="ui-button ui-button--outline" data-testid="scan-duplicates" disabled={scanning} onClick={onScan}>
            {scanning ? t('ui.confirmDialog.pending') : t('vnd.duplicates.scan.action')}
          </button>
        ) : undefined
      }
    >
      <p className="vnd-note" data-testid="duplicates-rule">
        {t('vnd.duplicates.rule.text')}
      </p>
      {view.duplicates.length === 0 ? (
        <Empty text={t('vnd.duplicates.empty.text')} testId="duplicates-empty" />
      ) : (
        <DataTable<Duplicate>
          caption={t('vnd.duplicates.table.caption')}
          rows={view.duplicates}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-duplicate-id': row.id })}
          columns={[
            {
              key: 'a',
              header: t('vnd.duplicates.column.a'),
              pinned: true,
              render: (row) => (
                <span className="vnd-stack">
                  <Link to={PATHS.profile(row.contractor_a_id)}>{row.contractor_a_name}</Link>
                  <span className="vnd-days">{row.contractor_a_tax}</span>
                </span>
              ),
            },
            {
              key: 'b',
              header: t('vnd.duplicates.column.b'),
              render: (row) => (
                <span className="vnd-stack">
                  <Link to={PATHS.profile(row.contractor_b_id)}>{row.contractor_b_name}</Link>
                  <span className="vnd-days">{row.contractor_b_tax}</span>
                </span>
              ),
            },
            {
              key: 'score',
              header: t('vnd.duplicates.column.score'),
              align: 'right',
              render: (row) => (
                <span className="vnd-row">
                  {numberText(row.score, locale)}
                  <CountInfo name={t('vnd.duplicates.figure.score.name')} formula={t('vnd.duplicates.figure.score.formula')} source={t('vnd.duplicates.figure.score.source')} asOf={view.as_of} unverified />
                </span>
              ),
            },
            { key: 'signals', header: t('vnd.duplicates.column.signals'), render: (row) => row.signals.map((signal) => signalLabel(t, signal)).join(', ') },
            {
              key: 'status',
              header: t('vnd.duplicates.column.status'),
              render: (row) => (
                <span className="vnd-stack">
                  <StatusPill tone={row.status === 'OPEN' ? 'warning' : 'neutral'}>{duplicateStatusLabel(t, row.status)}</StatusPill>
                  {row.decision_reason !== null && <span className="vnd-days">{row.decision_reason}</span>}
                </span>
              ),
            },
            {
              key: 'actions',
              header: t('vnd.duplicates.column.actions'),
              render: (row) =>
                canDecide && row.status === 'OPEN' ? (
                  <span className="vnd-row">
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="dismiss-duplicate" onClick={() => onDecide(row, 'DISMISSED')}>
                      {t('vnd.duplicates.dismiss.action')}
                    </button>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="merge-duplicate" onClick={() => onDecide(row, 'MERGE_REQUESTED')}>
                      {t('vnd.duplicates.merge.action')}
                    </button>
                  </span>
                ) : null,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- restrictions, cases, reputation ---------------------------------------------------------------------------------------------------------------------------

export function RestrictionsTab({ view, canPropose }: { view: ProfileView; canPropose: boolean }) {
  const { t, locale } = useTranslation();
  const escalation = view.escalation;
  return (
    <div className="vnd-page">
      <SectionCard
        title={t('vnd.restrictions.section.title')}
        status={<UnverifiedPill />}
        actions={
          canPropose ? (
            <Link className="ui-button ui-button--outline" to={`${PATHS.cases}?contractor=${view.profile.contractor_id}`} data-testid="open-case-link">
              {t('vnd.restrictions.open.action')}
            </Link>
          ) : undefined
        }
      >
        {view.restrictions.length === 0 ? (
          <Empty text={t('vnd.restrictions.empty.text')} testId="restrictions-empty" />
        ) : (
          <DataTable<RestrictionLine>
            caption={t('vnd.restrictions.table.caption')}
            rows={view.restrictions}
            rowKey={(row) => row.id}
            columns={[
              { key: 'kind', header: t('vnd.restrictions.column.kind'), pinned: true, render: (row) => row.kind },
              { key: 'source', header: t('vnd.restrictions.column.source'), render: (row) => (row.case_id === null ? row.source : <Link to={PATHS.caseOf(row.case_id)}>{row.source}</Link>) },
              { key: 'from', header: t('vnd.restrictions.column.from'), render: (row) => dayText(row.effective_from) },
              { key: 'until', header: t('vnd.restrictions.column.until'), render: (row) => (row.effective_until === null ? t('vnd.restrictions.until.open') : dayText(row.effective_until)) },
              {
                key: 'state',
                header: t('vnd.restrictions.column.state'),
                render: (row) =>
                  row.lifted ? <StatusPill tone="neutral">{t('vnd.restrictions.state.lifted')}</StatusPill> : row.in_force ? <StatusPill tone="danger" icon="⛔">{t('vnd.restrictions.state.inForce')}</StatusPill> : <StatusPill tone="neutral">{t('vnd.restrictions.state.ended')}</StatusPill>,
              },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title={t('vnd.restrictions.escalation.title')} status={<UnverifiedPill />}>
        <p className="vnd-row" data-testid="escalation">
          <span>{t('vnd.restrictions.escalation.count.text', { count: numberText(escalation.decisions_in_force, locale) })}</span>
          <CountInfo name={t('vnd.restrictions.figure.escalation.name')} formula={t('vnd.restrictions.figure.escalation.formula')} source={t('vnd.restrictions.figure.escalation.source')} asOf={view.as_of} unverified />
        </p>
        {escalation.suggestion !== 'NONE' && (
          <p className="callout vnd-suggestion" data-testid="escalation-suggestion">
            {t('vnd.restrictions.escalation.suggestion.text', { scope: suggestionLabel(t, escalation.suggestion) })}
          </p>
        )}
      </SectionCard>
      <SectionCard title={t('vnd.restrictions.cases.title')}>
        {view.cases.length === 0 ? (
          <Empty text={t('vnd.restrictions.cases.empty.text')} testId="cases-empty" />
        ) : (
          <DataTable<CaseLine>
            caption={t('vnd.restrictions.cases.caption')}
            rows={view.cases}
            rowKey={(row) => row.id}
            rowAttrs={(row) => ({ 'data-case-id': row.id })}
            columns={[
              { key: 'no', header: t('vnd.restrictions.cases.column.no'), pinned: true, render: (row) => <Link to={PATHS.caseOf(row.id)}>{row.case_no}</Link> },
              { key: 'status', header: t('vnd.restrictions.cases.column.status'), render: (row) => <StatusPill tone={caseStatusTone(row.status)}>{caseStatusLabel(t, row.status)}</StatusPill> },
              { key: 'groups', header: t('vnd.restrictions.cases.column.groups'), render: (row) => row.violation_groups.map((group) => groupLabel(t, group)).join(', ') },
              { key: 'clock', header: t('vnd.restrictions.cases.column.clock'), render: (row) => <ClockCell clock={row.clock} dueAt={row.decide_by} asOf={view.as_of} /> },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title={t('vnd.restrictions.reputation.title')} actions={<Link to={PATHS.reputation()}>{t('vnd.restrictions.reputation.link')}</Link>}>
        {view.reputation_events.length === 0 ? (
          <Empty text={t('vnd.restrictions.reputation.empty.text')} testId="reputation-empty" />
        ) : (
          <DataTable<ReputationEvent>
            caption={t('vnd.restrictions.reputation.caption')}
            rows={view.reputation_events}
            rowKey={(row) => row.id}
            columns={[
              { key: 'behaviour', header: t('vnd.restrictions.reputation.column.behaviour'), pinned: true, render: (row) => <Link to={PATHS.reputation(row.id)}>{behaviourLabel(t, row.behaviour_code)}</Link> },
              { key: 'on', header: t('vnd.restrictions.reputation.column.on'), render: (row) => dayText(row.event_on) },
              { key: 'status', header: t('vnd.restrictions.reputation.column.status'), render: (row) => eventStatusLabel(t, row.status) },
              { key: 'clock', header: t('vnd.restrictions.reputation.column.clock'), render: (row) => <ClockCell clock={row.clock} dueAt={row.post_due_at} asOf={view.as_of} /> },
            ]}
          />
        )}
      </SectionCard>
      <SectionCard title={t('vnd.restrictions.security.title')} status={<UnverifiedPill />}>
        <p className="vnd-row" data-testid="bid-security">
          <span>
            {view.bid_security.multiplier > 1
              ? t('vnd.restrictions.security.raised.text', { multiplier: view.bid_security.multiplier, until: view.bid_security.until === null ? NONE : dayText(view.bid_security.until) })
              : t('vnd.restrictions.security.normal.text')}
          </span>
          <CountInfo name={t('vnd.restrictions.figure.security.name')} formula={t('vnd.restrictions.figure.security.formula')} source={t('vnd.restrictions.figure.security.source')} asOf={view.as_of} unverified />
        </p>
        <p className="vnd-days">{t('vnd.restrictions.security.policy.text', { version: view.bid_security.policy_version })}</p>
      </SectionCard>
    </div>
  );
}

// ---- joint ventures ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function VenturesTab({ view }: { view: ProfileView }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.ventures.section.title')} actions={<Link to={PATHS.reputation()}>{t('vnd.ventures.link')}</Link>}>
      {view.ventures.length === 0 ? (
        <Empty text={t('vnd.ventures.empty.text')} testId="ventures-empty" />
      ) : (
        <DataTable<Venture>
          caption={t('vnd.ventures.table.caption')}
          rows={view.ventures}
          rowKey={(row) => row.id}
          columns={[
            { key: 'name', header: t('vnd.ventures.column.name'), pinned: true, render: (row) => row.name },
            { key: 'status', header: t('vnd.ventures.column.status'), render: (row) => ventureStatusLabel(t, row.status) },
            {
              key: 'members',
              header: t('vnd.ventures.column.members'),
              render: (row) => (
                <ul className="vnd-list">
                  {row.members.map((member) => (
                    <li key={member.contractor_id}>
                      {t('vnd.ventures.member.text', { name: member.contractor_name, share: member.share_pct })}
                      {member.lead && <StatusPill tone="info">{t('vnd.ventures.lead.badge')}</StatusPill>}
                    </li>
                  ))}
                </ul>
              ),
            },
            { key: 'from', header: t('vnd.ventures.column.from'), render: (row) => dayText(row.starts_on) },
          ]}
        />
      )}
    </SectionCard>
  );
}

// ---- the gate check ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function GateTab({ view }: { view: ProfileView }) {
  const { t } = useTranslation();
  const [action, setAction] = useState<GateAction>('BID_SUBMISSION');
  const [request, setRequest] = useState<{ contractor: string; action: GateAction } | undefined>(undefined);
  const check = useGateCheck(request);
  const result = check.data;
  return (
    <SectionCard title={t('vnd.gate.section.title')} status={view.policies.gate.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note vnd-row" data-testid="gate-rule">
        <span>{t('vnd.gate.rule.text')}</span>
        <PolicyInfo name={t('vnd.gate.figure.name')} policy={view.policies.gate} />
      </p>
      <form
        className="vnd-inline-form"
        aria-label={t('vnd.gate.form.label')}
        onSubmit={(event) => {
          event.preventDefault();
          setRequest({ contractor: view.profile.contractor_id, action });
        }}
      >
        <div className="vnd-field">
          <label htmlFor="gate-action">{t('vnd.gate.action.label')}</label>
          <select id="gate-action" value={action} onChange={(event) => setAction(GATE_ACTIONS.find((item) => item === event.target.value) ?? 'BID_SUBMISSION')}>
            {GATE_ACTIONS.map((item) => (
              <option key={item} value={item}>
                {gateActionLabel(t, item)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button type="submit" className="ui-button ui-button--primary" data-testid="gate-run" disabled={check.isFetching}>
            {check.isFetching ? t('ui.confirmDialog.pending') : t('vnd.gate.run.action')}
          </button>
        </div>
      </form>
      {check.isError && (
        <p className="callout" role="alert" data-testid="gate-error">
          {t('vnd.gate.error.text')}
        </p>
      )}
      {result !== undefined && (
        <div className="vnd-gate-result" data-testid="gate-result" data-allowed={result.allowed ? 'true' : 'false'} role="status">
          <p className="vnd-row">
            <StatusPill tone={result.allowed ? 'success' : 'danger'} icon={result.allowed ? '✓' : '⛔'}>
              {result.allowed ? t('vnd.gate.result.allowed') : t('vnd.gate.result.refused')}
            </StatusPill>
            <strong>{gateActionLabel(t, result.action)}</strong>
          </p>
          {!result.allowed && (
            <p data-testid="gate-refusal">
              {refusalLabel(t, result.refusal_code)} <code>{result.refusal_code}</code>
            </p>
          )}
          {Object.keys(result.refusal_extensions).length > 0 && (
            <ul data-testid="gate-extensions">
              {Object.entries(result.refusal_extensions).map(([name, value]) => (
                <li key={name}>
                  {name}: {typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}
                </li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <div data-testid="gate-warnings">
              <strong>{t('vnd.gate.warnings.title')}</strong>
              <ul>
                {result.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    {warningLabel(t, warning.code)} <code>{warning.code}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="vnd-days" data-testid="gate-checks">
            {t('vnd.gate.checks.text', { checks: result.checks.map((item) => gateCheckLabel(t, item)).join(', ') })} · {t('vnd.gate.asOf.text', { time: vietnamStamp(result.as_of) })}
          </p>
        </div>
      )}
    </SectionCard>
  );
}
