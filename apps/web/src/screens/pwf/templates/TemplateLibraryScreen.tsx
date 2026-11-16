import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { MoveDialog } from '../../adm/governance/components';
import type { Receipt } from '../../adm/governance/components';
import { useCatalogue, useEffective } from '../../adm/governance/hooks';
import { moveText, receiptText } from '../../adm/governance/labels';
import { movesOf } from '../../adm/governance/model';
import { ProjectTypeName } from '../codes';

import { useProjectTypeNames } from '../hooks';
import { PATHS, PERMISSIONS, RULE_PERMISSIONS, TEMPLATE_RULE_TYPE, dayText, editorLink, holds, todayInVietnam } from '../model';
import { ASSIGNMENT_RULE_CODE, ASSIGNMENT_RULE_TYPE, linesFor } from './assignment-model';
import { useTemplateCodes, useTemplateUsage } from './hooks';
import { libraryRow } from './library-model';
import type { LibraryRow } from './library-model';
import '../pwf.css';
import './templates.css';
import './editor.css';

/**
 * PWF-01: the library of procedures, one row for each template: its name, the kinds of project that take it, its steps and total time, the version in force and its state, the projects running it, the steps whose legal
 * grounds nobody checked against the source text, and the last change; open it, copy it, retire it. A new procedure starts from the kinds the platform ships, from a copy, from rows pasted from a spreadsheet, or empty.
 */
export default function TemplateLibraryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <LibraryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

/** The ways a new procedure starts, as the address of the editor says them (`?start=`). */
export const startLink = (kind: 'blank' | 'paste' | 'builtin' | 'clone', code?: string): string => `${PATHS.editor}?start=${kind}${code === undefined ? '' : `:${encodeURIComponent(code)}`}`;

function LibraryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const mayRead = holds(permissions, PERMISSIONS.read);
  const canEdit = holds(permissions, PERMISSIONS.templateManage, mode === 'READ_ONLY');
  const canStore = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const catalogue = useCatalogue(mayRead);
  const entry = catalogue.data?.find((one) => one.ruleType === TEMPLATE_RULE_TYPE);
  const codes = useMemo(() => entry?.codes ?? [], [entry]);
  const reads = useTemplateCodes(
    codes.map((code) => code.code),
    mayRead && entry !== undefined,
  );
  const assignment = useEffective(ASSIGNMENT_RULE_TYPE, ASSIGNMENT_RULE_CODE, undefined, mayRead);
  const usage = useTemplateUsage(mayRead);
  const queryState = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data === undefined ? undefined : codes });
  const state = !mayRead ? 'denied' : queryState;
  const failed = reads.some((read) => read.isError);
  const rows = codes.flatMap((code, index): LibraryRow[] => {
    const read = reads[index]?.data;
    if (read === undefined) return [];
    const mapped = linesFor(assignment.data?.params, code.code).flatMap((line) => line.when.filter((one) => one.field === 'project_type').flatMap((one) => one.in));
    return [libraryRow(code, read.versions, read.effective, mapped)];
  });
  const [retiring, setRetiring] = useState<LibraryRow | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const me = tenant?.membershipId;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.templates.lib.title.text')}</h1>
          <p>{t('pwf.templates.lib.subtitle.text')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        {failed ? (
          <p className="callout danger" role="alert" data-testid="rows-failed">
            {t('pwf.templates.lib.failed.text')}
          </p>
        ) : null}
        {receipt === undefined ? null : (
          <p className="callout success" role="status" data-testid="receipt">
            {receiptText(t, receipt.move, { version: receipt.version, code: receipt.code, time: receipt.time })}
          </p>
        )}
        {canEdit ? <QuickStart rows={rows} builtIn={codes.filter((code) => code.hasDefault).map((code) => code.code)} /> : null}
        <SectionCard title={t('pwf.templates.lib.table.title')}>
          <LibraryTable
            rows={rows}
            canEdit={canEdit}
            usage={usage}
            retireAllowed={(row) => row.inForce !== undefined && movesOf(row.inForce, { me, canManage: canStore, canApprove, today: todayInVietnam() }).some((option) => option.move === 'retire' && option.allowed)}
            onRetire={setRetiring}
          />
        </SectionCard>
      </StateBoundary>
      {retiring?.inForce === undefined ? null : (
        <MoveDialog
          version={retiring.inForce}
          move="retire"
          me={me}
          onClose={() => setRetiring(undefined)}
          onDone={(done) => {
            setRetiring(undefined);
            setReceipt(done);
          }}
        />
      )}
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

/** "Tạo quy trình": four ways to begin, each one a step to the editor and nothing written yet. */
function QuickStart({ rows, builtIn }: { rows: readonly LibraryRow[]; builtIn: readonly string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [shipped, setShipped] = useState('');
  const [copied, setCopied] = useState('');
  const nameOf = (code: string): string => rows.find((row) => row.code === code)?.summary?.name || code;
  return (
    <div className="pwfx-quick">
      <p>
        <button type="button" className="ui-button ui-button--primary" aria-expanded={open} data-testid="new-template" onClick={() => setOpen(!open)}>
          {t('pwfx.lib.new.action')}
        </button>
      </p>
      {!open ? null : (
        <div className="pwfx-quick__choices" data-testid="quick-start">
          <div className="pwfx-quick__choice">
            <strong>{t('pwfx.lib.start.builtin')}</strong>
            <span className="pwf-hint">{t('pwfx.lib.start.builtin.hint')}</span>
            <label htmlFor="pwfx-start-builtin">{t('pwfx.lib.start.builtin.pick')}</label>
            <select id="pwfx-start-builtin" value={shipped} data-testid="start-builtin" onChange={(event) => setShipped(event.target.value)}>
              <option value="">{t('pwfx.lib.start.choose')}</option>
              {builtIn.map((code) => (
                <option key={code} value={code}>
                  {nameOf(code)}
                </option>
              ))}
            </select>
            {shipped === '' ? null : (
              <Link className="ui-button ui-button--outline ui-button--small" to={startLink('builtin', shipped)} data-testid="go-builtin">
                {t('pwfx.lib.start.go')}
              </Link>
            )}
          </div>
          <div className="pwfx-quick__choice">
            <strong>{t('pwfx.lib.start.clone')}</strong>
            <span className="pwf-hint">{t('pwfx.lib.start.clone.hint')}</span>
            <label htmlFor="pwfx-start-clone">{t('pwfx.lib.start.clone.pick')}</label>
            <select id="pwfx-start-clone" value={copied} data-testid="start-clone" onChange={(event) => setCopied(event.target.value)}>
              <option value="">{t('pwfx.lib.start.choose')}</option>
              {rows.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.summary?.name || row.code}
                </option>
              ))}
            </select>
            {copied === '' ? null : (
              <Link className="ui-button ui-button--outline ui-button--small" to={startLink('clone', copied)} data-testid="go-clone">
                {t('pwfx.lib.start.go')}
              </Link>
            )}
          </div>
          <div className="pwfx-quick__choice">
            <strong>{t('pwfx.lib.start.paste')}</strong>
            <span className="pwf-hint">{t('pwfx.lib.start.paste.hint')}</span>
            <Link className="ui-button ui-button--outline ui-button--small" to={startLink('paste')} data-testid="go-paste">
              {t('pwfx.lib.start.go')}
            </Link>
          </div>
          <div className="pwfx-quick__choice">
            <strong>{t('pwfx.lib.start.blank')}</strong>
            <span className="pwf-hint">{t('pwfx.lib.start.blank.hint')}</span>
            <Link className="ui-button ui-button--outline ui-button--small" to={startLink('blank')} data-testid="go-blank">
              {t('pwfx.lib.start.go')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function StateCell({ row }: { row: LibraryRow }) {
  const { t } = useTranslation();
  const drafts = row.statusCounts.DRAFT;
  const waiting = row.statusCounts.SUBMITTED;
  return (
    <span className="pwf-lib-state">
      {row.force === 'RULE' ? (
        <StatusPill tone="success" icon="✔">
          {t('pwf.templates.lib.force.rule', { version: row.forceVersion })}
        </StatusPill>
      ) : row.force === 'DEFAULT' ? (
        <StatusPill tone="neutral" icon="◇">
          {t('pwf.templates.lib.force.default')}
        </StatusPill>
      ) : (
        <StatusPill tone="warning" icon="⚠">
          {t('pwf.templates.lib.force.none')}
        </StatusPill>
      )}
      {row.effectiveFrom === null ? null : <span className="pwf-hint">{t('pwfx.lib.from', { day: dayText(row.effectiveFrom) })}</span>}
      {drafts === 0 ? null : <StatusPill tone="neutral" icon="✎">{t('pwfx.lib.drafts', { count: drafts })}</StatusPill>}
      {waiting === 0 ? null : <StatusPill tone="info" icon="⏳">{t('pwfx.lib.waiting', { count: waiting })}</StatusPill>}
    </span>
  );
}

/** The mark of a template nobody has confirmed: a glyph in the template cell, its words (the same as everywhere else) for the screen reader and as the tooltip. */
function UnverifiedFlag() {
  const { t } = useTranslation();
  const words = t('pwf.common.unverified.label');
  return (
    <span className="pwf-lib-flag" title={words}>
      <span aria-hidden="true">⚠</span>
      <span className="ui-sr-only">{words}</span>
    </span>
  );
}

interface TableProps {
  rows: readonly LibraryRow[];
  canEdit: boolean;
  usage: ReadonlyMap<string, number> | undefined;
  retireAllowed: (row: LibraryRow) => boolean;
  onRetire: (row: LibraryRow) => void;
}

function LibraryTable({ rows, canEdit, usage, retireAllowed, onRetire }: TableProps) {
  const { t, locale } = useTranslation();
  const typeNames = useProjectTypeNames();
  const columns: DataTableColumn<LibraryRow>[] = [
    {
      key: 'template',
      header: t('fix9.pwf01.col.template'),
      pinned: true,
      render: (row) => (
        <span className="pwf-tpl-name">
          <strong title={row.summary?.name === '' || row.summary === null ? undefined : row.summary.name}>{row.summary?.name === '' || row.summary === null ? t('pwf.templates.lib.noName.text') : row.summary.name}</strong>
          <span className="pwf-lib-sub">
            <span className="pwf-code pwf-lib-code">{row.code}</span>
            {row.unverified ? <UnverifiedFlag /> : null}
          </span>
        </span>
      ),
    },
    {
      key: 'type',
      header: t('fix9.pwf01.col.type'),
      render: (row) =>
        row.types.length === 0 ? (
          <span className="pwf-hint">{t('fix9.pwf01.type.any')}</span>
        ) : (
          <span data-testid={`type-${row.code}`} className="pwf-lib-types">
            <ProjectTypeName code={row.types[0] as string} names={typeNames} />
            {row.types.length < 2 ? null : (
              <span className="pwf-lib-more" title={row.types.slice(1).join(', ')}>
                +{row.types.length - 1}
                <span className="ui-sr-only">
                  {row.types.slice(1).map((type) => (
                    <ProjectTypeName key={type} code={type} names={typeNames} />
                  ))}
                </span>
              </span>
            )}
          </span>
        ),
    },
    { key: 'steps', header: t('pwfx.lib.col.steps'), align: 'right', render: (row) => <span data-testid={`steps-${row.code}`}>{row.steps}</span> },
    { key: 'days', header: t('pwfx.lib.col.days'), align: 'right', render: (row) => <span data-testid={`days-${row.code}`}>{t('pwfx.lib.days', { days: row.totalDays })}</span> },
    { key: 'state', header: t('pwfx.lib.col.state'), render: (row) => <StateCell row={row} /> },
    {
      key: 'projects',
      header: t('pwfx.lib.col.projects'),
      align: 'right',
      render: (row) => <span data-testid={`projects-${row.code}`}>{usage === undefined ? '–' : (usage.get(row.code) ?? 0)}</span>,
    },
    {
      key: 'unverified',
      header: t('pwfx.lib.col.unverified'),
      align: 'right',
      render: (row) => (row.unverifiedSteps === 0 ? <span className="pwf-hint">{t('fix9.pwf01.flag.none')}</span> : <StatusPill tone="warning" icon="⚠">{t('pwfx.lib.unverified', { count: row.unverifiedSteps })}</StatusPill>),
    },
    {
      key: 'last',
      header: t('pwfx.lib.col.last'),
      render: (row) => <span data-testid={`last-${row.code}`}>{row.lastChange === null ? '–' : new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(row.lastChange))}</span>,
    },
    {
      key: 'actions',
      header: t('pwf.templates.col.actions.header'),
      render: (row) => (
        <span className="pwf-pills pwf-nowrap">
          <Link className="ui-button ui-button--outline ui-button--small" to={editorLink(row.code)} data-testid={`open-${row.code}`}>
            {t('pwfx.lib.open')}
          </Link>
          {canEdit ? (
            <Link className="ui-button ui-button--outline ui-button--small" to={startLink('clone', row.code)} data-testid={`clone-${row.code}`}>
              {t('pwfx.lib.clone')}
            </Link>
          ) : null}
          {canEdit && row.force === 'RULE' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={!retireAllowed(row)} title={retireAllowed(row) ? undefined : t('pwfx.lib.retire.needsBoth')} data-testid={`retire-${row.code}`} onClick={() => onRetire(row)}>
              {moveText(t, 'retire', 'APPROVED')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <div className="pwf-free pwf-lib">
      <DataTable columns={columns} rows={[...rows]} rowKey={(row) => row.code} caption={t('pwf.templates.lib.table.caption')} stacked />
    </div>
  );
}
