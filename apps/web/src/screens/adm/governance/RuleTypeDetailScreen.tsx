import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill, Timeline } from '../../../ui';
import type { TimelineEntry, TimelineGroup } from '../../../ui';
import { BlockNote, LegalChip, MoveDialog, SideBySide, VersionPill, periodText, personText } from './components';
import type { Receipt } from './components';
import { useBuiltInDefault, useCatalogue, useEffective, useVersions } from './hooks';
import { moveText, receiptText } from './labels';
import type { Translate } from './labels';
import { APPROVE_PERMISSION, MANAGE_PERMISSION, READ_PERMISSION, dayText, isRuleCode, isRuleType, isUuid, momentText, movesOf, textParam } from './model';
import type { CodeEntry, Move, RuleTypeEntry, RuleVersion } from './model';
import '../adm-kit.css';
import './governance.css';

const encode = encodeURIComponent;

/**
 * ADM-20: one kind of governance rule (G0-1). Opened with only the type, it lists the codes under it, what governs each and the numbers' provenance. Opened with a code, it sets the rule in force beside the built-in
 * default, lists every version in the order it was written (draft, submitted, approved, retired, with who and when) and offers the moves: submit, withdraw, approve by a third person, retire. A version never changes;
 * a change is a new version (ADM-21), and two versions are compared on ADM-22.
 */
export default function RuleTypeDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DetailContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [params] = useSearchParams();
  const rawType = textParam(params.get('type'));
  const rawCode = textParam(params.get('code'));
  const rawUnit = textParam(params.get('unit_id'));
  const ruleType = rawType !== undefined && isRuleType(rawType) ? rawType : undefined;
  const code = rawCode !== undefined && isRuleCode(rawCode) ? rawCode : undefined;
  const unitId = rawUnit !== undefined && isUuid(rawUnit) ? rawUnit : undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const writable = mode !== 'READ_ONLY';
  const canManage = writable && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));
  const canApprove = writable && (permissions === undefined || permissions.includes(APPROVE_PERMISSION));
  const catalogue = useCatalogue(mayRead && ruleType !== undefined);
  const catalogueState = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data, isEmpty: () => false });
  const entry = catalogue.data?.find((one) => one.ruleType === ruleType);
  const state = !mayRead ? 'denied' : catalogueState;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{code === undefined ? t('gova1.detail.title.type', { type: ruleType ?? '' }) : t('gova1.detail.title.code', { type: ruleType ?? '', code })}</h1>
          <p>{t('gova1.detail.subtitle')}</p>
        </div>
        <nav className="gova1-links" aria-label={t('gova1.links.label')}>
          <Link to="/adm/adm-19" data-testid="link-catalogue">
            {t('gova1.detail.link.catalogue')}
          </Link>
          {ruleType !== undefined && code !== undefined ? (
            <Link to={`/adm/adm-20?type=${encode(ruleType)}`} data-testid="link-type">
              {t('gova1.detail.link.type', { type: ruleType })}
            </Link>
          ) : null}
          {canManage && ruleType !== undefined ? (
            <Link className="ui-button ui-button--primary" to={`/adm/adm-21?type=${encode(ruleType)}${code === undefined ? '' : `&code=${encode(code)}`}${unitId === undefined ? '' : `&unit_id=${unitId}`}`} data-testid="new-version">
              {t('gova1.detail.new')}
            </Link>
          ) : null}
        </nav>
      </div>
      <ContextBar
        items={[
          { label: t('gova1.ctx.scope'), value: tenant?.name ?? t('gova1.ctx.scopeAll') },
          ...(ruleType === undefined ? [] : [{ label: t('gova1.ctx.type'), value: ruleType }]),
          ...(code === undefined ? [] : [{ label: t('gova1.ctx.code'), value: code }]),
          ...(unitId === undefined ? [] : [{ label: t('gova1.ctx.unit'), value: unitId.slice(0, 8) }]),
        ]}
      />
      {ruleType === undefined ? (
        <p className="gova1-callout" role="status" data-testid="no-target">
          {t('gova1.detail.noTarget')}
        </p>
      ) : rawCode !== undefined && code === undefined ? (
        <p className="gova1-callout gova1-callout--error" role="alert" data-testid="bad-code">
          {t('gova1.detail.badCode')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
          {entry === undefined ? (
            <p className="gova1-callout gova1-callout--error" role="alert" data-testid="unknown-type">
              {t('gova1.detail.unknownType', { type: ruleType })}
            </p>
          ) : code === undefined ? (
            <TypeOverview entry={entry} canManage={canManage} unitId={unitId} />
          ) : (
            <CodeDetail entry={entry} code={code} unitId={unitId} canManage={canManage} canApprove={canApprove} writable={writable} mayRead={mayRead} locale={locale} />
          )}
        </StateBoundary>
      )}
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

// ---- The type with no code chosen: what it is and its codes -----------------------------------------------------------------------------------------------------------

function TypeOverview({ entry, canManage, unitId }: { entry: RuleTypeEntry; canManage: boolean; unitId: string | undefined }) {
  const { t } = useTranslation();
  const forceOf = (row: CodeEntry): string => (row.inForce === 'RULE' ? t('gova1.detail.force.rule', { version: row.inForceVersion }) : row.inForce === 'DEFAULT' ? t('gova1.detail.force.default') : t('gova1.detail.force.none'));
  return (
    <>
      <SectionCard title={t('gova1.detail.about.title')} status={entry.legalStatus === null ? undefined : <LegalChip status={entry.legalStatus} />}>
        <dl className="gova1-facts" data-testid="about">
          <dt>{t('gova1.detail.about.owner')}</dt>
          <dd>{entry.ownerModule ?? t('gova1.common.none')}</dd>
          <dt>{t('gova1.detail.about.modules')}</dt>
          <dd>{entry.modules.length === 0 ? t('gova1.common.none') : entry.modules.join(', ')}</dd>
          <dt>{t('gova1.detail.about.formula')}</dt>
          <dd>{entry.formula ?? t('gova1.common.none')}</dd>
          <dt>{t('gova1.detail.about.source')}</dt>
          <dd>{entry.source ?? t('gova1.common.none')}</dd>
          <dt>{t('gova1.detail.about.asOf')}</dt>
          <dd>{entry.asOf === null ? t('gova1.common.none') : dayText(entry.asOf)}</dd>
        </dl>
        {entry.registered ? null : (
          <p className="gova1-callout gova1-callout--warn" role="status" data-testid="unregistered">
            {t('gova1.detail.unregistered')}
          </p>
        )}
      </SectionCard>
      <SectionCard title={t('gova1.detail.codes.title')}>
        <DataTable<CodeEntry>
          caption={t('gova1.detail.codes.caption', { type: entry.ruleType })}
          rows={entry.codes}
          rowKey={(row) => row.code}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          state={entry.codes.length === 0 ? 'empty' : 'ready'}
          columns={[
            {
              key: 'code',
              header: t('gova1.detail.codes.code'),
              pinned: true,
              render: (row) => (
                <Link to={`/adm/adm-20?type=${encodeURIComponent(entry.ruleType)}&code=${encodeURIComponent(row.code)}${unitId === undefined ? '' : `&unit_id=${unitId}`}`} data-testid={`open-${row.code}`}>
                  {row.code}
                </Link>
              ),
            },
            { key: 'force', header: t('gova1.detail.codes.force'), render: (row) => forceOf(row) },
            { key: 'legal', header: t('gova1.detail.codes.legal'), render: (row) => (row.unverified ? <LegalChip status="UNVERIFIED" /> : row.hasDefault ? <LegalChip status="VERIFIED" /> : t('gova1.common.none')) },
            { key: 'versions', header: t('gova1.detail.codes.versions'), align: 'right', render: (row) => String(row.storedVersions) },
            {
              key: 'source',
              header: t('gova1.detail.codes.source'),
              render: (row) => (row.provenance === null ? t('gova1.detail.codes.noDefault') : <span className="gova1-wrap">{row.provenance.source}<span className="adm-kit-sub">{t('gova1.catalogue.asOf', { day: dayText(row.provenance.asOf) })}</span></span>),
            },
          ]}
        />
        {canManage ? (
          <p>
            <Link to={`/adm/adm-21?type=${encodeURIComponent(entry.ruleType)}`} data-testid="new-code">
              {t('gova1.detail.codes.new')}
            </Link>
          </p>
        ) : null}
      </SectionCard>
    </>
  );
}

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const dayOfInstant = (iso: string): string => new Date(Date.parse(iso) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** What was done to the versions of one code, by day: written, submitted, approved, retired, each with who did it (the history of the moves, apart from the versions themselves). */
export function chronologyOf(versions: readonly RuleVersion[], me: string | undefined, t: Translate): TimelineGroup[] {
  const entries: TimelineEntry[] = [];
  const actor = (id: string | null) => (id === null ? null : { name: personText(t, id, me), initials: personText(t, id, me).slice(0, 2).toUpperCase() });
  for (const version of versions) {
    const params = { version: version.version };
    if (version.createdAt !== '') entries.push({ id: `${version.id}:created`, at: version.createdAt, kind: 'note', title: t('gova1.timeline.created', params), actor: actor(version.createdBy), note: version.reason });
    if (version.submittedAt !== null) entries.push({ id: `${version.id}:submitted`, at: version.submittedAt, kind: 'transition', title: t('gova1.timeline.submitted', params), actor: actor(version.submittedBy) });
    if (version.approvedAt !== null) entries.push({ id: `${version.id}:approved`, at: version.approvedAt, kind: 'checklist', title: t('gova1.timeline.approved', params), actor: actor(version.approvedBy) });
    if (version.retiredAt !== null) entries.push({ id: `${version.id}:retired`, at: version.retiredAt, kind: 'hold', title: t('gova1.timeline.retired', params), actor: actor(version.retiredBy), ...(version.retireReason === null ? {} : { note: version.retireReason }) });
  }
  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const day = dayOfInstant(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([date, group]) => ({ date, entries: group.sort((a, b) => (a.at < b.at ? 1 : -1)) }));
}

// ---- One code: in force beside the default, and the versions ---------------------------------------------------------------------------------------------------------

interface CodeDetailProps {
  entry: RuleTypeEntry;
  code: string;
  unitId: string | undefined;
  canManage: boolean;
  canApprove: boolean;
  writable: boolean;
  mayRead: boolean;
  locale: string;
}

function CodeDetail({ entry, code, unitId, canManage, canApprove, writable, mayRead, locale }: CodeDetailProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const me = tenant?.membershipId;
  const versions = useVersions(entry.ruleType, code, unitId, mayRead);
  const effective = useEffective(entry.ruleType, code, unitId, mayRead);
  const builtIn = useBuiltInDefault(entry.ruleType, code, mayRead);
  const [dialog, setDialog] = useState<{ version: RuleVersion; move: Move } | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const versionsState = useScreenState({ isLoading: versions.isLoading, error: versions.error, data: versions.data, isEmpty: () => false });
  const today = effective.data?.asOf ?? '';
  const list = versions.data ?? [];
  const resolved = effective.data ?? undefined;
  const defaults = builtIn.data ?? undefined;
  const provenance = resolved?.provenance ?? defaults?.provenance ?? null;
  const unverified = resolved?.unverified === true || defaults?.unverified === true;

  return (
    <>
      {receipt === undefined ? null : (
        <p className="gova1-callout gova1-callout--ok" role="status" data-testid="receipt">
          {receiptText(t, receipt.move, { version: receipt.version, code: receipt.code, time: receipt.time })}
        </p>
      )}
      <SectionCard
        title={t('gova1.detail.force.title')}
        status={
          resolved === undefined ? undefined : (
            <StatusPill tone={resolved.source === 'RULE' ? 'success' : 'neutral'} icon={resolved.source === 'RULE' ? '✔' : '◇'}>
              {resolved.source === 'RULE' ? t('gova1.detail.force.rule', { version: resolved.version }) : t('gova1.detail.force.default')}
            </StatusPill>
          )
        }
      >
        {effective.isLoading || builtIn.isLoading ? (
          <div role="status" aria-busy="true" aria-label={t('states.loading.label')} className="skeleton" data-testid="force-loading" />
        ) : effective.error !== null || builtIn.error !== null ? (
          <div className="gova1-callout gova1-callout--error" role="alert" data-testid="force-error">
            <p>{t('gova1.detail.force.error')}</p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => { void effective.refetch(); void builtIn.refetch(); }}>
              {t('states.retry.action')}
            </button>
          </div>
        ) : resolved === undefined ? (
          <p className="gova1-callout gova1-callout--warn" role="status" data-testid="no-rule">
            {t('gova1.detail.force.noRule')}
          </p>
        ) : (
          <>
            {unverified ? (
              <p className="gova1-chips" data-testid="unverified">
                <LegalChip status="UNVERIFIED" />
                <span>{t('gova1.legal.unverified.hint')}</span>
              </p>
            ) : null}
            {provenance === null ? null : (
              <dl className="gova1-facts" data-testid="provenance">
                <dt>{t('gova1.detail.about.formula')}</dt>
                <dd>{provenance.formula}</dd>
                <dt>{t('gova1.detail.about.source')}</dt>
                <dd>{provenance.source}</dd>
                <dt>{t('gova1.detail.about.asOf')}</dt>
                <dd>{dayText(provenance.asOf)}</dd>
              </dl>
            )}
            <SideBySide
              caption={t('gova1.detail.force.caption', { type: entry.ruleType, code })}
              leftLabel={resolved.source === 'RULE' ? t('gova1.detail.force.rule', { version: resolved.version }) : t('gova1.detail.force.default')}
              rightLabel={t('gova1.detail.force.defaultColumn')}
              left={resolved.params}
              right={defaults?.params}
            />
            {defaults === undefined ? <p className="adm-kit-sub">{t('gova1.detail.force.noDefault')}</p> : null}
          </>
        )}
      </SectionCard>
      <SectionCard title={t('gova1.detail.versions.title')}>
        <StateBoundary state={versionsState} onRetry={() => void versions.refetch()}>
          {list.length === 0 ? (
            <p className="adm-kit-empty" data-testid="no-versions">
              {t('gova1.detail.versions.none')}
            </p>
          ) : (
            <ol className="gova1-timeline" aria-label={t('gova1.detail.versions.caption', { type: entry.ruleType, code })} data-testid="timeline">
              {list.map((version, index) => {
                const previous = list[index + 1];
                const options = writable ? movesOf(version, { me, canManage, canApprove, today }).filter((option) => option.allowed || option.block !== undefined) : [];
                return (
                  <li key={version.id} data-version={version.id} data-phase={version.phase} data-status={version.status}>
                    <div className="gova1-chips">
                      <h3>{t('gova1.detail.version.title', { version: version.version })}</h3>
                      <VersionPill version={version} />
                      {version.unitId === null ? null : <span className="adm-kit-sub">{t('gova1.detail.version.unit', { unit: version.unitId.slice(0, 8) })}</span>}
                    </div>
                    <p>{periodText(t, version.effectiveFrom, version.effectiveTo)}</p>
                    <p data-testid="reason">{t('gova1.detail.version.reason', { reason: version.reason })}</p>
                    <p className="adm-kit-sub" data-testid="people">
                      {t('gova1.detail.version.people', {
                        maker: personText(t, version.createdBy, me),
                        made: momentText(version.createdAt, locale),
                      })}
                      {version.submittedBy === null ? '' : ` · ${t('gova1.detail.version.submitted', { who: personText(t, version.submittedBy, me), at: momentText(version.submittedAt, locale) })}`}
                      {version.approvedBy === null ? '' : ` · ${t('gova1.detail.version.approved', { who: personText(t, version.approvedBy, me), at: momentText(version.approvedAt, locale) })}`}
                      {version.retiredBy === null ? '' : ` · ${t('gova1.detail.version.retired', { who: personText(t, version.retiredBy, me), at: momentText(version.retiredAt, locale), reason: version.retireReason ?? '' })}`}
                    </p>
                    <div className="gova1-actions">
                      <Link to={`/adm/adm-22?rule=${version.id}${previous === undefined ? '' : `&against=${previous.id}`}`} data-testid={`diff-${version.version}`}>
                        {previous === undefined ? t('gova1.detail.version.diffDefault') : t('gova1.detail.version.diff', { version: previous.version })}
                      </Link>
                      {canManage ? (
                        <Link to={`/adm/adm-21?type=${encodeURIComponent(entry.ruleType)}&code=${encodeURIComponent(code)}&from=${version.id}${unitId === undefined ? '' : `&unit_id=${unitId}`}`} data-testid={`from-${version.version}`}>
                          {t('gova1.detail.version.from')}
                        </Link>
                      ) : null}
                      {options.map((option) => (
                        <span key={option.move}>
                          <button
                            type="button"
                            className={option.move === 'approve' || option.move === 'submit' ? 'ui-button ui-button--primary ui-button--small' : 'ui-button ui-button--outline ui-button--small'}
                            data-action={`${option.move}-${version.version}`}
                            disabled={!option.allowed}
                            aria-describedby={option.block === undefined ? undefined : `block-${version.id}-${option.move}`}
                            onClick={() => {
                              setReceipt(undefined);
                              setDialog({ version, move: option.move });
                            }}
                          >
                            {moveText(t, option.move, version.status)}
                          </button>
                          {option.block === undefined ? null : (
                            <span id={`block-${version.id}-${option.move}`}>
                              <BlockNote block={option.block} />
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </StateBoundary>
      </SectionCard>
      {list.length === 0 ? null : (
        <SectionCard title={t('gova1.timeline.title')}>
          <Timeline caption={t('gova1.timeline.caption', { type: entry.ruleType, code })} groups={chronologyOf(list, me, t)} today={today === '' ? undefined : today} />
        </SectionCard>
      )}
      {dialog === undefined ? null : (
        <MoveDialog
          version={dialog.version}
          move={dialog.move}
          me={me}
          onClose={() => setDialog(undefined)}
          onDone={(done) => {
            setDialog(undefined);
            setReceipt(done);
          }}
        />
      )}
    </>
  );
}
