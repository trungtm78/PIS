import { Link } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import type { Translator } from '../../../../i18n';
import { decisionKindLabel } from '../../../../screens/cap/labels';
import { documentLink } from '../../../../screens/doc/repository/model';
import { DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../../ui';
import { dayText, moneyText } from '../shared/format';
import { Fact } from '../shared/parts';
import { BUILT_IN_DOC_TYPES, camel, evidenceOf, findingsOf, isNamedOrigin, milestoneTone, reachedWithoutEvidence } from './model';
import type { LegalGroup, Milestone, OriginAmount, Profile } from './model';

type Translate = Translator['t'];

/** The words for a legal document type: the label the catalogue gave (the API sends it for every type the project holds), else the words of the built-in catalogue, else the code as it is. */
function docTypeLabel(t: Translate, code: string, groups: readonly LegalGroup[]): string {
  const group = groups.find((one) => one.legal_doc_type === code);
  if (group !== undefined && group.label !== code) return group.label;
  return BUILT_IN_DOC_TYPES.includes(code) ? t(`ipf.docType.${camel(code)}.label`) : code;
}

/** The type of project, the flag of the stage in the plan year (new start or carry-over) with the year it rests on, and the annual plans the split is read from. */
export function ClassificationSection({ profile }: { profile: Profile }) {
  const { t, locale } = useTranslation();
  const type = profile.project_type;
  const flag = profile.start_flag;
  return (
    <SectionCard title={t('ipf.class.title')}>
      <dl className="ent2-facts">
        <Fact label={t('ipf.class.type.label')} testId="fact-type">
          {type === null ? t('ipf.class.type.none') : `${type.label}${type.kind === null ? '' : ` (${t(`ipf.kind.${camel(type.kind)}.label`)})`}`}
        </Fact>
        <Fact label={t('ipf.class.flag.label', { year: profile.plan_year })} testId="fact-flag">
          {flag === null ? (
            <span data-testid="flag-unknown">{t('ipf.class.flag.unknown')}</span>
          ) : (
            <StatusPill tone={flag === 'NEW_START' ? 'info' : 'neutral'}>{t(`ipf.flag.${camel(flag)}.label`)}</StatusPill>
          )}
        </Fact>
        <Fact label={t('ipf.class.start.label')} testId="fact-start">
          {profile.start_year === null || profile.start_year_basis === null ? t('ipf.class.start.none') : t('ipf.class.start.text', { year: profile.start_year, basis: t(`ipf.basis.${camel(profile.start_year_basis)}.label`) })}
        </Fact>
        <Fact label={t('ipf.class.plans.label')} testId="fact-plans">
          {profile.plans.length === 0 ? (
            t('ipf.class.plans.none', { year: profile.plan_year })
          ) : (
            <ul className="ipf-list">
              {profile.plans.map((plan) => (
                <li key={`${plan.plan_code ?? ''}:${plan.revision}`}>
                  {t('ipf.class.plans.item', { code: plan.plan_code ?? t('ipf.class.plans.noCode'), status: t(`ipf.plan.${camel(plan.status)}.status`), revision: plan.revision.toLocaleString(locale) })}
                </li>
              ))}
            </ul>
          )}
        </Fact>
      </dl>
    </SectionCard>
  );
}

/** What the register finds wrong with the order of the milestones: one reached before an earlier one, and a required one that was not reached although a later one was. Silence is said, never left blank. */
export function FindingsSection({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  const findings = findingsOf(profile.findings);
  const labelOf = (code: string): string => profile.milestones.find((milestone) => milestone.code === code)?.label ?? code;
  return (
    <SectionCard title={t('ipf.findings.title')}>
      {findings.length === 0 ? (
        <p className="ent2-none" data-testid="findings-none">
          {t('ipf.findings.none')}
        </p>
      ) : (
        <ul className="ipf-list" data-testid="findings">
          {findings.map((finding) => (
            <li key={`${finding.kind}:${finding.code}`} className="callout warning" data-finding={finding.kind} data-milestone={finding.code}>
              {finding.kind === 'MILESTONE_ORDER' ? t('ipf.findings.order.text', { milestone: labelOf(finding.code) }) : t('ipf.findings.skipped.text', { milestone: labelOf(finding.code) })}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** The milestones of the catalogue in its order, each with its state, its planned and actual day, and the evidence it asks for against the documents the project holds. */
export function MilestonesSection({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  const groups = profile.legal_documents;
  return (
    <SectionCard title={t('ipf.milestones.title')}>
      <p className="ent2-note">{t('ipf.milestones.hint')}</p>
      <DataTable<Milestone>
        caption={t('ipf.milestones.caption')}
        rowKey={(row) => row.code}
        rowAttrs={(row) => ({ 'data-milestone': row.code, 'data-state': row.state })}
        rows={profile.milestones}
        columns={[
          { key: 'sequence', header: t('ipf.milestones.col.sequence'), align: 'right', render: (row) => row.sequence },
          {
            key: 'milestone',
            header: t('ipf.milestones.col.milestone'),
            render: (row) => (
              <span className="ent2-stack">
                <strong>{row.label}</strong>
                <span className="ent2-key">{row.code}</span>
              </span>
            ),
          },
          { key: 'phase', header: t('ipf.milestones.col.phase'), render: (row) => t(`ipf.phase.${camel(row.phase)}.label`) },
          { key: 'required', header: t('ipf.milestones.col.required'), render: (row) => (row.required ? t('ipf.milestones.required.yes') : t('ipf.milestones.required.no')) },
          { key: 'state', header: t('ipf.milestones.col.state'), render: (row) => <StatusPill tone={milestoneTone(row.state)}>{t(`ipf.state.${camel(row.state)}.label`)}</StatusPill> },
          { key: 'planned', header: t('ipf.milestones.col.planned'), render: (row) => (row.planned_on === null ? '–' : dayText(row.planned_on)) },
          { key: 'actual', header: t('ipf.milestones.col.actual'), render: (row) => (row.actual_on === null ? '–' : dayText(row.actual_on)) },
          {
            key: 'evidence',
            header: t('ipf.milestones.col.evidence'),
            render: (row) => (
              <span className="ent2-stack">
                {evidenceOf(row, groups).map((kind) => (
                  <span key={kind.code} data-evidence={kind.code} data-held={kind.held}>
                    {kind.held === 0 ? t('ipf.milestones.evidence.missing', { type: docTypeLabel(t, kind.code, groups) }) : t('ipf.milestones.evidence.held', { type: docTypeLabel(t, kind.code, groups), count: kind.held })}
                  </span>
                ))}
                {reachedWithoutEvidence(row, groups) ? (
                  <span className="field-error" data-testid="no-evidence">
                    {t('ipf.milestones.evidence.none')}
                  </span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

/** The legal documents of the project by type of the catalogue: the documents that are in force or not yet, with the reference and the period, each opening the document. */
export function LegalDocumentsSection({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  const groups = profile.legal_documents;
  return (
    <SectionCard title={t('ipf.legal.title')}>
      {groups.length === 0 ? (
        <p className="ent2-none" data-testid="legal-none">
          {t('ipf.legal.none')}
        </p>
      ) : (
        groups.map((group) => (
          <article key={group.legal_doc_type} className="ipf-group" data-testid="legal-group" data-type={group.legal_doc_type}>
            <h3 className="ipf-group__title">
              {docTypeLabel(t, group.legal_doc_type, groups)} <span className="ent2-key">{group.legal_doc_type}</span>
            </h3>
            <p className="ent2-note">
              {group.issuer === null ? null : <StatusPill tone="neutral">{t(`ipf.issuer.${camel(group.issuer)}.label`)}</StatusPill>}{' '}
              {group.purpose === null ? null : <StatusPill tone="neutral">{t(`ipf.purpose.${camel(group.purpose)}.label`)}</StatusPill>}{' '}
              <span data-testid="legal-count">{t('ipf.legal.count.text', { count: group.count })}</span>
            </p>
            <ul className="ipf-list">
              {group.documents.map((document) => (
                <li key={document.id} data-document={document.id}>
                  <Link to={documentLink(document.id)}>{document.title}</Link>
                  {document.reference === null ? null : <span className="ent2-key"> {document.reference}</span>}{' '}
                  <StatusPill tone={document.effective_state === 'IN_FORCE' ? 'success' : document.effective_state === 'EXPIRED' ? 'warning' : 'neutral'}>{t(`ipf.effective.${camel(document.effective_state)}.label`)}</StatusPill>
                  {document.effective_from === null && document.effective_to === null ? null : (
                    <span className="sub">
                      {' '}
                      {t('ipf.legal.period.text', { from: dayText(document.effective_from) || '–', to: dayText(document.effective_to) || '–' })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {group.count > group.documents.length ? (
              <p className="ent2-note" data-testid="legal-more">
                {t('ipf.legal.more.text', { shown: group.documents.length, count: group.count })}
              </p>
            ) : null}
          </article>
        ))
      )}
    </SectionCard>
  );
}

/** The words for an origin of a plan line: the resolution of the group, the decision of the company, or the code of another origin as it is. */
function originLabel(t: Translate, origin: string): string {
  if (!isNamedOrigin(origin)) return t('ipf.origin.other.label', { origin });
  return origin === 'GROUP_ASSIGNED' ? t('ipf.origin.groupAssigned.label') : t('ipf.origin.boardApproved.label');
}

/** The plan of the year split by who gave the capital: what the group assigned by its resolution, what the company approved by its own decision, and the rest, with the documents each rests on. */
export function OriginSplitSection({ profile }: { profile: Profile }) {
  const { t, locale } = useTranslation();
  const split = profile.origin_split;
  return (
    <SectionCard title={t('ipf.origin.title', { year: profile.plan_year })}>
      {split.origins.length === 0 ? (
        <p className="ent2-none" data-testid="origin-none">
          {t('ipf.origin.none', { year: profile.plan_year })}
        </p>
      ) : (
        <>
          <KpiStrip label={t('ipf.origin.strip.label')}>
            <KpiTile label={t('ipf.origin.total.label')} value={moneyText(split.total_vnd, locale)} unit={t('ipf.origin.unit.label')} tone="info" />
            <KpiTile label={t('ipf.origin.groupAssigned.label')} value={moneyText(split.group_assigned_vnd, locale)} unit={t('ipf.origin.unit.label')} />
            <KpiTile label={t('ipf.origin.boardApproved.label')} value={moneyText(split.board_approved_vnd, locale)} unit={t('ipf.origin.unit.label')} />
            <KpiTile label={t('ipf.origin.rest.label')} value={moneyText(split.other_vnd, locale)} unit={t('ipf.origin.unit.label')} />
          </KpiStrip>
          <DataTable<OriginAmount>
            caption={t('ipf.origin.caption')}
            rowKey={(row) => row.origin}
            rowAttrs={(row) => ({ 'data-origin': row.origin })}
            rows={split.origins}
            columns={[
              { key: 'origin', header: t('ipf.origin.col.origin'), render: (row) => originLabel(t, row.origin) },
              { key: 'lines', header: t('ipf.origin.col.lines'), align: 'right', render: (row) => row.lines.toLocaleString(locale) },
              { key: 'amount', header: t('ipf.origin.col.amount'), align: 'right', render: (row) => moneyText(row.amount_vnd, locale) },
              {
                key: 'decisions',
                header: t('ipf.origin.col.decisions'),
                render: (row) =>
                  row.decisions.length === 0 ? (
                    <span data-testid="decision-none">{t('ipf.origin.decisions.none')}</span>
                  ) : (
                    <ul className="ipf-list">
                      {row.decisions.map((decision) => (
                        <li key={`${decision.kind ?? ''}:${decision.symbol}`} data-decision={decision.symbol}>
                          {decision.kind === null ? null : <strong>{decisionKindLabel(t, decision.kind)} </strong>}
                          <span className="ent2-key">{decision.symbol}</span>
                          {decision.issued_on === null && decision.authority === null ? null : (
                            <span className="sub">
                              {' '}
                              {t('ipf.origin.decision.issued', { day: decision.issued_on === null ? '–' : dayText(decision.issued_on), authority: decision.authority ?? '–' })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]}
          />
        </>
      )}
    </SectionCard>
  );
}
