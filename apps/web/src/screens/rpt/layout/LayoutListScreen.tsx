import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { holds } from '../../../session/holds';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { useRuleMove, useVersions } from '../../adm/governance/hooks';
import type { RuleVersion } from '../../adm/governance/model';
import { DemoBadge, refusalText } from '../components';
import { useCatalogue } from '../hooks';
import { kindWord, statusWord, vietnamDateTime } from '../model';
import type { Entry } from '../model';
import '../rpt.css';
import './layout.css';
import { APPROVE_PERMISSION, MAKE_PERMISSION, REASON_MIN, RULE_TYPE } from './model';

const CODE_PREFIX = 'CFG_';
const tone = (status: string): Tone => (status === 'APPROVED' ? 'success' : status === 'SUBMITTED' ? 'info' : status === 'RETIRED' ? 'neutral' : 'warning');

type Step = { kind: 'submit' | 'approve' | 'withdraw'; version: RuleVersion };

/**
 * RPT-07, the layouts of forms that were configured without code (ENT-4b, R23). The catalogue lists the configured forms in force today (the version that governs, its status, its receiver); a code opens its versions, each
 * written by one person, submitted and approved by others, with the audit of the rule store (ADM-11). The official forms of PVN, HPM and the Ministry are owned by code and do not appear here.
 */
export default function LayoutListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const selected = search.get('code') ?? undefined;
  const catalogue = useCatalogue();
  const versions = useVersions(RULE_TYPE, selected, undefined, selected !== undefined);
  const move = useRuleMove();
  const [step, setStep] = useState<Step | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const entries = (catalogue.data?.items ?? []).filter((entry) => entry.code.startsWith(CODE_PREFIX));
  const state = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.data === undefined ? catalogue.error : undefined, data: catalogue.data, isEmpty: () => entries.length === 0 });

  const columns: DataTableColumn<Entry>[] = [
    { key: 'code', header: t('rpt.layout.col.code'), pinned: true, render: (row) => <strong>{row.code}</strong> },
    { key: 'name', header: t('rpt.layout.col.name'), render: (row) => row.name },
    { key: 'kind', header: t('rpt.layout.col.kind'), render: (row) => (row.receiver === 'INTERNAL' ? t('rpt.layout.kind.internal') : t('rpt.layout.kind.agencyRequest')) },
    { key: 'version', header: t('rpt.layout.col.version'), render: (row) => row.version },
    { key: 'status', header: t('rpt.layout.col.status'), render: (row) => (row.status === 'DEMO' ? <DemoBadge mark={row.demo_mark} /> : <StatusPill tone="success">{t(`rpt.common.status.${statusWord(row.status)}`)}</StatusPill>) },
    { key: 'receiver', header: t('rpt.layout.col.receiver'), render: (row) => row.receiver },
    { key: 'period', header: t('rpt.layout.col.period'), render: (row) => t(`rpt.common.kind.${kindWord(row.period_kind)}`) },
    {
      key: 'actions',
      header: t('rpt.layout.col.actions'),
      render: (row) => (
        <span className="rpt-lay__actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`versions-${row.code}`} onClick={() => setSearch({ code: row.code })}>
            {t('rpt.layout.action.versions')}
          </button>
          {holds(permissions, MAKE_PERMISSION) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`edit-${row.code}`} onClick={() => navigate(`/rpt/rpt-08?code=${row.code}`)}>
              {t('rpt.layout.action.edit')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];

  const versionColumns: DataTableColumn<RuleVersion>[] = [
    { key: 'version', header: t('rpt.layout.col.version'), pinned: true, render: (row) => `v${row.version}` },
    { key: 'status', header: t('rpt.layout.col.status'), render: (row) => <StatusPill tone={tone(row.status)}>{t(`rpt.layout.rule.${row.status.toLowerCase()}`)}</StatusPill> },
    { key: 'from', header: t('rpt.layout.col.from'), render: (row) => row.effectiveFrom },
    { key: 'to', header: t('rpt.layout.col.to'), render: (row) => row.effectiveTo ?? '–' },
    { key: 'reason', header: t('rpt.layout.col.reason'), render: (row) => row.reason },
    { key: 'created', header: t('rpt.layout.col.created'), render: (row) => vietnamDateTime(row.createdAt) },
    {
      key: 'steps',
      header: t('rpt.layout.col.actions'),
      render: (row) => (
        <span className="rpt-lay__actions">
          {row.status === 'DRAFT' && holds(permissions, MAKE_PERMISSION) ? (
            <button type="button" className="ui-button ui-button--small" data-testid={`submit-${row.version}`} onClick={() => setStep({ kind: 'submit', version: row })}>
              {t('rpt.layout.action.submit')}
            </button>
          ) : null}
          {row.status === 'SUBMITTED' && holds(permissions, APPROVE_PERMISSION) ? (
            <button type="button" className="ui-button ui-button--small" data-testid={`approve-${row.version}`} onClick={() => setStep({ kind: 'approve', version: row })}>
              {t('rpt.layout.action.approve')}
            </button>
          ) : null}
          {row.status === 'SUBMITTED' && holds(permissions, MAKE_PERMISSION) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`withdraw-${row.version}`} onClick={() => setStep({ kind: 'withdraw', version: row })}>
              {t('rpt.layout.action.withdraw')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.layout.list.title')}</h1>
          <p>{t('rpt.layout.list.subtitle')}</p>
        </div>
        {holds(permissions, MAKE_PERMISSION) ? (
          <button type="button" className="ui-button" data-testid="new-layout" onClick={() => navigate('/rpt/rpt-08')}>
            {t('rpt.layout.action.new')}
          </button>
        ) : null}
      </div>
      <ContextBar items={[{ label: t('rpt.layout.context.scope'), value: tenant?.name ?? '–' }]} {...(catalogue.data === undefined ? {} : { asOf: vietnamDateTime(catalogue.data.as_of) })} stale={catalogue.isError && catalogue.data !== undefined} />
      <p className="callout" role="note">
        {t('rpt.layout.list.owned')}
      </p>
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        <DataTable caption={t('rpt.layout.list.caption')} columns={columns} rows={entries} rowKey={(row) => row.code} />
      </StateBoundary>
      {selected === undefined ? null : (
        <section aria-label={t('rpt.layout.versions.title', { code: selected })} data-testid="versions">
          <h2>{t('rpt.layout.versions.title', { code: selected })}</h2>
          {versions.isError ? (
            <p className="callout warning" role="alert">
              {t('rpt.layout.versions.error')}
            </p>
          ) : (
            <DataTable caption={t('rpt.layout.versions.caption')} columns={versionColumns} rows={versions.data ?? []} rowKey={(row) => row.id} />
          )}
        </section>
      )}
      {step === undefined ? null : (
        <ConfirmDialog
          open
          title={t(`rpt.layout.step.${step.kind}.title`, { code: step.version.code, version: step.version.version })}
          context={[
            { label: t('rpt.layout.col.code'), value: step.version.code },
            { label: t('rpt.layout.col.version'), value: `v${step.version.version}` },
            { label: t('rpt.layout.col.from'), value: step.version.effectiveFrom },
          ]}
          confirmLabel={t(`rpt.layout.step.${step.kind}.confirm`)}
          cancelLabel={t('rpt.layout.step.cancel')}
          pending={move.isPending}
          reason={{ label: t('rpt.layout.step.reason'), required: true, minLength: REASON_MIN, hint: t('rpt.layout.step.reason.hint', { min: REASON_MIN }) }}
          {...(error === undefined ? {} : { error })}
          onCancel={() => {
            setStep(undefined);
            setError(undefined);
          }}
          onConfirm={(reason) =>
            move.mutate(
              { move: step.kind, id: step.version.id, version: step.version.resourceVersion, reason: (reason ?? '').trim() },
              {
                onSuccess: () => {
                  setStep(undefined);
                  setError(undefined);
                  void versions.refetch();
                  void catalogue.refetch();
                },
                onError: (failure) => setError(refusalText(t, failure)),
              },
            )
          }
        />
      )}
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
