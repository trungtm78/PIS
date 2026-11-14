import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useCatalogue } from '../../adm/governance/hooks';
import { statusText } from '../../adm/governance/labels';
import type { RuleStatus } from '../../adm/governance/model';
import { factName } from '../codes';
import { FigureInfo, UnverifiedLabel } from '../components';
import { PATHS, PERMISSIONS, TEMPLATE_RULE_TYPE, dayText, editorLink, holds } from '../model';
import { useTemplateCodes } from './hooks';
import { DEFAULT_SIDE, compareSides, libraryRow, libraryTotals } from './library-model';
import type { CompareSide, LibraryRow } from './library-model';
import { TemplateCompare } from './Compare';
import '../pwf.css';
import './templates.css';

/** ADM-20, the versions of one code in the rule store. */
const RULE_VERSIONS_PATH = '/adm/adm-20';
const STATUS_ORDER: readonly RuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];

/** PWF-01: the library of workflow templates by kind of project: versions and their state, the day each begins, whether it was confirmed, and two versions side by side. */
export default function TemplateLibraryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <LibraryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LibraryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayRead = holds(permissions, PERMISSIONS.read);
  const canEdit = holds(permissions, PERMISSIONS.templateManage, mode === 'READ_ONLY');
  const catalogue = useCatalogue(mayRead);
  const entry = catalogue.data?.find((one) => one.ruleType === TEMPLATE_RULE_TYPE);
  const codes = entry?.codes ?? [];
  const reads = useTemplateCodes(
    codes.map((code) => code.code),
    mayRead && entry !== undefined,
  );
  const queryState = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data === undefined ? undefined : codes });
  const state = !mayRead ? 'denied' : queryState;
  const failed = reads.some((read) => read.isError);
  const loading = reads.some((read) => read.isLoading);
  const rows = codes.flatMap((code, index): LibraryRow[] => {
    const read = reads[index]?.data;
    return read === undefined ? [] : [libraryRow(code, read.versions, read.effective)];
  });
  const totals = libraryTotals(rows);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.templates.lib.title.text')}</h1>
          <p>{t('pwf.templates.lib.subtitle.text')}</p>
        </div>
        {canEdit ? (
          <Link className="ui-button ui-button--primary" to={editorLink()} data-testid="new-template">
            {t('pwf.templates.lib.new.action')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        {failed ? (
          <p className="callout danger" role="alert" data-testid="rows-failed">
            {t('pwf.templates.lib.failed.text')}
          </p>
        ) : null}
        <KpiStrip label={t('pwf.templates.lib.totals.label')}>
          <KpiTile
            label={t('pwf.templates.lib.totals.templates')}
            value={String(totals.templates)}
            sub={<FigureInfo name={t('pwf.templates.lib.totals.templates')} formula={t('pwf.templates.lib.formula.templates')} source={t('pwf.templates.lib.source.store')} asOf={null} version={t('pwf.templates.lib.version.store')} />}
            state={loading ? 'loading' : 'ready'}
          />
          <KpiTile
            label={t('pwf.templates.lib.totals.governed')}
            value={String(totals.governed)}
            sub={<FigureInfo name={t('pwf.templates.lib.totals.governed')} formula={t('pwf.templates.lib.formula.governed')} source={t('pwf.templates.lib.source.store')} asOf={null} version={t('pwf.templates.lib.version.store')} />}
            state={loading ? 'loading' : 'ready'}
          />
          <KpiTile
            label={t('pwf.templates.lib.totals.unverified')}
            value={String(totals.unverified)}
            tone={totals.unverified > 0 ? 'warning' : 'default'}
            sub={<FigureInfo name={t('pwf.templates.lib.totals.unverified')} formula={t('pwf.templates.lib.formula.unverified')} source={t('pwf.templates.lib.source.catalogue')} asOf={null} version={t('pwf.templates.lib.version.store')} unverified />}
            state={loading ? 'loading' : 'ready'}
          />
        </KpiStrip>
        <SectionCard title={t('pwf.templates.lib.table.title')}>
          <LibraryTable rows={rows} canEdit={canEdit} />
        </SectionCard>
        <ComparePanel rows={rows} />
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

function ForceCell({ row }: { row: LibraryRow }) {
  const { t } = useTranslation();
  if (row.force === 'RULE') return <StatusPill tone="success" icon="✔">{t('pwf.templates.lib.force.rule', { version: row.forceVersion })}</StatusPill>;
  if (row.force === 'DEFAULT') return <StatusPill tone="neutral" icon="◇">{t('pwf.templates.lib.force.default')}</StatusPill>;
  return <StatusPill tone="warning" icon="⚠">{t('pwf.templates.lib.force.none')}</StatusPill>;
}

function LibraryTable({ rows, canEdit }: { rows: readonly LibraryRow[]; canEdit: boolean }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<LibraryRow>[] = [
    {
      key: 'template',
      header: t('pwf.templates.col.template.header'),
      pinned: true,
      render: (row) => (
        <span className="pwf-tpl-name">
          <strong>{row.summary?.name === '' || row.summary === null ? t('pwf.templates.lib.noName.text') : row.summary.name}</strong>
          <span className="pwf-code">{row.code}</span>
          {row.summary?.projectType === null || row.summary?.projectType === undefined ? null : (
            <span className="pwf-hint">
              {t('pwf6.lib.type.label')} <span>{factName(t, row.summary.projectType)}</span>
            </span>
          )}
          {row.unverified ? <UnverifiedLabel /> : null}
        </span>
      ),
    },
    {
      key: 'versions',
      header: t('pwf.templates.col.versions.header'),
      render: (row) =>
        row.versions.length === 0 ? (
          <span className="pwf-hint">{t('pwf.templates.lib.noVersions.text')}</span>
        ) : (
          <span className="pwf-pills">
            {STATUS_ORDER.filter((status) => row.statusCounts[status] > 0).map((status) => (
              <span key={status} data-status={status}>
                <VersionPillByStatus status={status} count={row.statusCounts[status]} />
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'force',
      header: t('pwf.templates.col.force.header'),
      render: (row) => (
        <span className="pwf-tpl-name">
          <ForceCell row={row} />
          {row.effectiveFrom === null ? null : (
            <span className="pwf-hint">
              {t('pwf6.lib.from.label')} <span>{dayText(row.effectiveFrom)}</span>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('pwf.templates.col.size.header'),
      render: (row) =>
        row.summary === null ? null : (
          <span className="pwf-tpl-name pwf-nowrap">
            <span>{t('pwf.templates.lib.size.text', { phases: row.summary.phases, tasks: row.summary.tasks })}</span>
            {row.summary.steps === undefined ? null : <span className="pwf-hint">{t('pwf.templates.lib.steps.text', { steps: row.summary.steps })}</span>}
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('pwf.templates.col.actions.header'),
      render: (row) => (
        <span className="pwf-pills pwf-nowrap">
          {canEdit ? (
            <Link className="ui-button ui-button--outline ui-button--small" to={editorLink(row.code)} data-testid={`edit-${row.code}`}>
              {t('pwf.templates.lib.edit.action')}
            </Link>
          ) : null}
          <Link className="ui-button ui-button--outline ui-button--small" to={`${RULE_VERSIONS_PATH}?type=${TEMPLATE_RULE_TYPE}&code=${encodeURIComponent(row.code)}`} data-testid={`versions-${row.code}`}>
            {t('pwf.templates.lib.versions.action')}
          </Link>
        </span>
      ),
    },
  ];
  return (
    <div className="pwf-free pwf-lib">
      <DataTable columns={columns} rows={[...rows]} rowKey={(row) => row.code} caption={t('pwf.templates.lib.table.caption')} />
    </div>
  );

}

const STATUS_LOOK: Readonly<Record<RuleStatus, { tone: 'neutral' | 'info' | 'success'; icon: string }>> = {
  DRAFT: { tone: 'neutral', icon: '✎' },
  SUBMITTED: { tone: 'info', icon: '⏳' },
  APPROVED: { tone: 'success', icon: '✔' },
  RETIRED: { tone: 'neutral', icon: '■' },
};

function VersionPillByStatus({ status, count }: { status: RuleStatus; count: number }) {
  const { t } = useTranslation();
  const look = STATUS_LOOK[status];
  return (
    <StatusPill tone={look.tone} icon={look.icon}>
      {t('pwf.templates.lib.count.text', { status: statusText(t, status), count })}
    </StatusPill>
  );
}

function ComparePanel({ rows }: { rows: readonly LibraryRow[] }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const row = rows.find((one) => one.code === code);
  const reads = useTemplateCodes(row === undefined ? [] : [row.code], row !== undefined);
  const data = reads[0]?.data;
  const sides: CompareSide[] = data === undefined ? [] : compareSides(data.versions, data.effective);
  const left = sides.find((side) => side.id === leftId);
  const right = sides.find((side) => side.id === rightId);
  const changes = left === undefined || right === undefined ? undefined : true;
  const sideLabel = (side: CompareSide): string => (side.id === DEFAULT_SIDE ? t('pwf.templates.compare.default.option') : t('pwf.templates.compare.version.option', { version: side.version, status: side.status === 'DEFAULT' ? '' : statusText(t, side.status) }).trim());

  return (
    <SectionCard title={t('pwf.templates.compare.title')}>
      <div className="pwf-filters">
        <div className="pwf-field">
          <label htmlFor="pwf-cmp-code">{t('pwf.templates.compare.code.label')}</label>
          <select
            id="pwf-cmp-code"
            data-testid="compare-code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setLeftId('');
              setRightId('');
            }}
          >
            <option value="">{t('pwf.templates.compare.choose.option')}</option>
            {rows.map((one) => (
              <option key={one.code} value={one.code}>
                {one.summary === null || one.summary.name === '' ? one.code : t('pwf6.lib.option.text', { name: one.summary.name, code: one.code })}
              </option>
            ))}
          </select>
        </div>
        <div className="pwf-field">
          <label htmlFor="pwf-cmp-left">{t('pwf.templates.compare.left.label')}</label>
          <select id="pwf-cmp-left" data-testid="compare-left" value={leftId} disabled={sides.length === 0} onChange={(event) => setLeftId(event.target.value)}>
            <option value="">{t('pwf.templates.compare.choose.option')}</option>
            {sides.map((side) => (
              <option key={side.id} value={side.id}>
                {sideLabel(side)}
              </option>
            ))}
          </select>
        </div>
        <div className="pwf-field">
          <label htmlFor="pwf-cmp-right">{t('pwf.templates.compare.right.label')}</label>
          <select id="pwf-cmp-right" data-testid="compare-right" value={rightId} disabled={sides.length === 0} onChange={(event) => setRightId(event.target.value)}>
            <option value="">{t('pwf.templates.compare.choose.option')}</option>
            {sides.map((side) => (
              <option key={side.id} value={side.id}>
                {sideLabel(side)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {changes === undefined ? (
        <p className="callout" role="status" data-testid="compare-pick">
          {t('pwf.templates.compare.pick.text')}
        </p>
      ) : left === undefined || right === undefined ? null : (
        <TemplateCompare before={left.template} after={right.template} left={sideLabel(left)} right={sideLabel(right)} />
      )}
      {left !== undefined && right !== undefined && left.id !== DEFAULT_SIDE && right.id !== DEFAULT_SIDE ? (
        <p>
          <Link className="pwf-hint" to={`${PATHS.ruleDiff}?rule=${right.id}&against=${left.id}`} data-testid="compare-diff">
            {t('pwf6.cmp.raw.action')}
          </Link>
        </p>
      ) : null}
    </SectionCard>
  );
}
