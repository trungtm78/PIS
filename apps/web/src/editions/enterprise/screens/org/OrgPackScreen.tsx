import { useState } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../../ui';
import { failureCode, vietnamStamp } from '../shared/format';
import { Fact, ReadonlyNote } from '../shared/parts';
import { useMaterialisePack, useOrgPack } from './hooks';
import { PLAN_ACTIONS, UUID_PATTERN, camel, csvBlob, toneOf, unitsInOrder } from './model';
import type { OrgPack } from './model';
import '../shared/shared.css';

/**
 * ORG-01, the organisation and the roles of the enterprise edition (ENT-3d; HT.02, HT.03, MD.03, QT.01 of the customer spec). The PVFCCo template is shown as it is - units, roles with their scope, seats with the directory
 * group that fills each, the staged approval with its deadlines, the delegation defaults, the shared catalogues - next to what the tenant has now: the plan (what a load would create, what stands, what waits for approval,
 * what differs) and the seats against the people who hold them. The pack has no person in it. The load goes through the batch import of ADM; this screen downloads the file and turns an applied batch into the objects.
 */
export default function OrgPackScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <OrgPackContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OrgPackContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const [batchInput, setBatchInput] = useState('');
  const [batchId, setBatchId] = useState<string | undefined>(undefined);
  const query = useOrgPack(batchId);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const readOnly = mode === 'READ_ONLY';
  const batchProblem = batchInput !== '' && !UUID_PATTERN.test(batchInput.trim());

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('org.page.title')}</h1>
          <p>{t('org.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('org.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('org.context.pack.label'), value: data?.label ?? '–' },
        ]}
        {...(data === undefined ? {} : { asOf: vietnamStamp(data.as_of) })}
        stale={query.isError && data !== undefined}
      />
      {readOnly && <ReadonlyNote block="MODE" />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="ent2-page">
            <p className="callout" data-testid="template-note">
              {data.source === 'TEMPLATE' ? t('org.source.template.text', { label: data.label }) : t('org.source.batch.text', { label: data.label })}
            </p>
            <LoadSection pack={data} readOnly={readOnly} batchInput={batchInput} batchProblem={batchProblem} onBatchInput={setBatchInput} onShow={() => setBatchId(batchInput.trim())} onTemplate={() => { setBatchId(undefined); setBatchInput(''); }} />
            <VerificationSection pack={data} />
            <UnitsSection pack={data} />
            <RolesSection pack={data} />
            <SeatsSection pack={data} />
            <StepsSection pack={data} />
            <PolicySection pack={data} />
            <CatalogueSection pack={data} />
          </div>
        )}
      </StateBoundary>
    </section>
  );
}

function LoadSection({ pack, readOnly, batchInput, batchProblem, onBatchInput, onShow, onTemplate }: { pack: OrgPack; readOnly: boolean; batchInput: string; batchProblem: boolean; onBatchInput: (value: string) => void; onShow: () => void; onTemplate: () => void }) {
  const { t } = useTranslation();
  const load = useMaterialisePack();
  const [downloaded, setDownloaded] = useState(false);
  const download = (): void => {
    if (pack.file_csv === null) return;
    const url = URL.createObjectURL(csvBlob(pack.file_csv));
    const link = document.createElement('a');
    link.href = url;
    link.download = pack.loader.file_name;
    link.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };
  const result = load.data;
  const code = load.isError ? failureCode(load.error) : undefined;
  return (
    <SectionCard title={t('org.load.title')}>
      <ol className="ent2-actions" data-testid="load-steps">
        <li>{t('org.load.step1.text', { file: pack.loader.file_name })}</li>
        <li>{t('org.load.step2.text', { entity: pack.loader.target_entity, mapping: pack.loader.mapping_version, source: pack.loader.source_system })}</li>
        <li>{t('org.load.step3.text')}</li>
        <li>{t('org.load.step4.text')}</li>
        <li>{t('org.load.step5.text')}</li>
      </ol>
      <dl className="ent2-facts">
        <Fact label={t('org.load.digest.label')} testId="pack-digest">
          <span className="ent2-key">{pack.digest}</span>
        </Fact>
        <Fact label={t('org.load.rows.label')} testId="pack-rows">
          {pack.loader.row_count}
        </Fact>
      </dl>
      <div className="ent2-action">
        {pack.file_csv !== null && (
          <button type="button" className="ui-button ui-button--outline" data-testid="download-button" onClick={download}>
            {t('org.load.download.action')}
          </button>
        )}
        {downloaded && <span role="status">{t('org.load.downloaded.text')}</span>}
      </div>
      <div className="ent2-field" data-invalid={batchProblem}>
        <label htmlFor="org-batch">{t('org.batch.input.label')}</label>
        <input id="org-batch" data-testid="batch-input" value={batchInput} aria-invalid={batchProblem} onChange={(event) => onBatchInput(event.target.value)} />
        <span className="ent2-field__hint">{batchProblem ? t('org.batch.format.problem') : t('org.batch.input.hint')}</span>
      </div>
      <div className="ent2-action">
        <button type="button" className="ui-button ui-button--outline" data-testid="batch-show" disabled={batchInput.trim() === '' || batchProblem} onClick={onShow}>
          {t('org.batch.show.action')}
        </button>
        {pack.source === 'BATCH' && (
          <button type="button" className="ui-button ui-button--outline" data-testid="batch-template" onClick={onTemplate}>
            {t('org.batch.template.action')}
          </button>
        )}
        {pack.source === 'BATCH' && pack.batch_id !== null && (
          <button type="button" className="ui-button ui-button--primary" data-testid="materialise-button" disabled={readOnly || load.isPending || pack.defects.length > 0} onClick={() => load.mutate(pack.batch_id as string)}>
            {t('org.load.materialise.action')}
          </button>
        )}
      </div>
      {pack.defects.length > 0 && (
        <ul data-testid="defects" className="ent2-pending">
          {pack.defects.map((defect) => (
            <li key={`${defect.key}:${defect.code}:${defect.field}`}>
              <strong>{defect.code}</strong> <span className="ent2-key">{defect.key}</span> {defect.message}
            </li>
          ))}
        </ul>
      )}
      {code !== undefined && (
        <p className="callout" role="alert" data-testid="load-error">
          {t('org.load.error.text', { code })}
        </p>
      )}
      {result !== undefined && (
        <div data-testid="load-result" role="status">
          <p>{t('org.load.result.text', { created: result.counts.CREATED, unchanged: result.counts.UNCHANGED, pending: result.counts.PENDING, drift: result.counts.DRIFT, blocked: result.counts.BLOCKED })}</p>
          <p>{t('org.load.approval.text')}</p>
        </div>
      )}
    </SectionCard>
  );
}

function VerificationSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('org.verify.title')} status={<StatusPill tone={pack.structure_complete ? 'success' : 'warning'}>{pack.structure_complete ? t('org.verify.complete.badge') : t('org.verify.incomplete.badge')}</StatusPill>}>
      <ul className="ent2-stats" data-testid="plan-counts">
        {PLAN_ACTIONS.map((action) => (
          <li key={action} data-testid={`plan-${action}`}>
            <StatusPill tone={toneOf(action)}>{t(`org.plan.action.${camel(action)}`)}</StatusPill> <strong>{pack.counts[action]}</strong>
          </li>
        ))}
      </ul>
      <ul className="ent2-stats" data-testid="seat-counts">
        <li data-testid="seat-FILLED">
          {t('org.seat.state.filled')} <strong>{pack.seat_counts.FILLED}</strong>
        </li>
        <li data-testid="seat-VACANT">
          {t('org.seat.state.vacant')} <strong>{pack.seat_counts.VACANT}</strong>
        </li>
        <li data-testid="seat-OVER">
          {t('org.seat.state.over')} <strong>{pack.seat_counts.OVER}</strong>
        </li>
        <li data-testid="stray-grants">
          {t('org.verify.stray.label')} <strong>{pack.stray_grants}</strong>
        </li>
      </ul>
      <DataTable
        caption={t('org.plan.caption')}
        rowKey={(row) => row.key}
        rows={pack.plan.filter((item) => item.action !== 'UNCHANGED')}
        columns={[
          { key: 'key', header: t('org.plan.key.column'), render: (row) => <span className="ent2-key">{row.key}</span> },
          { key: 'action', header: t('org.plan.state.column'), render: (row) => <StatusPill tone={toneOf(row.action)}>{t(`org.plan.action.${camel(row.action)}`)}</StatusPill> },
          { key: 'detail', header: t('org.plan.detail.column'), render: (row) => row.detail },
        ]}
      />
    </SectionCard>
  );
}

function UnitsSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('org.units.title')} status={<StatusPill tone="info">{t('scr2.org.units.points', { count: String(pack.units.filter((unit) => unit.unit_function === 'INPUT_POINT').length).padStart(2, '0') })}</StatusPill>}>
      <DataTable
        caption={t('org.units.caption')}
        rowKey={(row) => row.code}
        rows={unitsInOrder(pack.units)}
        columns={[
          { key: 'code', header: t('org.units.code.column'), render: (row) => <span className="ent2-key">{row.code}</span> },
          { key: 'name', header: t('org.units.name.column'), render: (row) => (row.placeholder ? <em>{row.name}</em> : row.name) },
          { key: 'parent', header: t('org.units.parent.column'), render: (row) => row.parent_code ?? '–' },
          { key: 'function', header: t('org.units.function.column'), render: (row) => t(`org.function.${camel(row.unit_function)}`) },
          { key: 'present', header: t('org.units.present.column'), render: (row) => <StatusPill tone={row.present ? 'success' : 'neutral'}>{row.present ? t('org.present.yes.text') : t('org.present.no.text')}</StatusPill> },
        ]}
      />
    </SectionCard>
  );
}

function RolesSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('org.roles.title')}>
      <DataTable
        caption={t('org.roles.caption')}
        rowKey={(row) => row.code}
        rows={pack.roles}
        columns={[
          { key: 'code', header: t('org.roles.code.column'), render: (row) => <span className="ent2-key">{row.code}</span> },
          { key: 'name', header: t('org.roles.name.column'), render: (row) => row.name },
          { key: 'kind', header: t('org.roles.kind.column'), render: (row) => t(`org.kind.${camel(row.kind)}`) },
          { key: 'rank', header: t('org.roles.rank.column'), align: 'right', render: (row) => row.rank },
          { key: 'permissions', header: t('org.roles.permissions.column'), render: (row) => <details><summary>{row.permissions.length}</summary><span className="ent2-key">{row.permissions.join(', ')}</span></details> },
          { key: 'present', header: t('org.units.present.column'), render: (row) => <StatusPill tone={row.present ? 'success' : 'neutral'}>{row.present ? t('org.present.yes.text') : t('org.present.no.text')}</StatusPill> },
        ]}
      />
    </SectionCard>
  );
}

function SeatsSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  const tone = (state: string) => (state === 'FILLED' ? 'success' : state === 'OVER' ? 'danger' : 'warning');
  return (
    <SectionCard title={t('org.seats.title')}>
      <p className="ent2-note">{t('org.seats.note')}</p>
      <DataTable
        caption={t('org.seats.caption')}
        rowKey={(row) => row.key}
        rows={pack.seats}
        columns={[
          { key: 'unit', header: t('org.seats.unit.column'), render: (row) => <span className="ent2-key">{row.unit_code}</span> },
          { key: 'role', header: t('org.seats.role.column'), render: (row) => <span className="ent2-key">{row.role_code}</span> },
          { key: 'scope', header: t('org.seats.scope.column'), render: (row) => t(`org.scope.${camel(row.scope_kind)}`) },
          { key: 'holders', header: t('org.seats.holders.column'), align: 'right', render: (row) => `${row.holders} / ${row.min_holders}-${row.max_holders}` },
          { key: 'state', header: t('org.seats.state.column'), render: (row) => <StatusPill tone={tone(row.state)}>{t(`org.seat.state.${camel(row.state)}`)}</StatusPill> },
          { key: 'group', header: t('org.seats.group.column'), render: (row) => <span className="ent2-key">{row.ad_group}</span> },
        ]}
      />
    </SectionCard>
  );
}

function StepsSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('org.steps.title')}>
      <DataTable
        caption={t('org.steps.caption')}
        rowKey={(row) => row.id}
        rows={pack.steps}
        columns={[
          { key: 'order', header: t('org.steps.order.column'), align: 'right', render: (row) => pack.steps.indexOf(row) + 1 },
          { key: 'kind', header: t('org.steps.kind.column'), render: (row) => t(`org.step.kind.${camel(row.kind)}`) },
          { key: 'name', header: t('org.steps.name.column'), render: (row) => row.name },
          { key: 'who', header: t('org.steps.who.column'), render: (row) => (row.assignee === 'DOA' ? t('org.steps.doa.text', { role: pack.doa.role_code }) : `${row.role_code ?? ''} / ${row.unit_code ?? ''}`) },
          { key: 'sla', header: t('org.steps.sla.column'), align: 'right', render: (row) => row.sla_working_hours },
        ]}
      />
    </SectionCard>
  );
}

function PolicySection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  const absence = pack.absence as Record<string, unknown>;
  return (
    <SectionCard title={t('org.policy.title')}>
      <dl className="ent2-facts">
        <Fact label={t('org.policy.delegable.label')} testId="delegable">
          {pack.delegation.delegable_roles.join(', ')}
        </Fact>
        <Fact label={t('org.policy.maxdays.label')} testId="delegation-days">
          {pack.delegation.max_days}
        </Fact>
        <Fact label={t('org.policy.review.label')} testId="delegation-review">
          {pack.delegation.standing_review_days}
        </Fact>
        <Fact label={t('org.policy.cover.label')} testId="absence-cover">
          {String(absence.max_cover_days ?? '–')}
        </Fact>
        <Fact label={t('org.policy.doa.label')} testId="doa">
          {`${pack.doa.document_type} / ${pack.doa.unit_code} / ${pack.doa.role_code}`}
        </Fact>
        <Fact label={t('org.policy.directory.label')} testId="directory-prefix">
          {pack.directory_prefix}
        </Fact>
      </dl>
    </SectionCard>
  );
}

function CatalogueSection({ pack }: { pack: OrgPack }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('org.catalogue.title')}>
      <DataTable
        caption={t('org.catalogue.caption')}
        rowKey={(row) => `${row.master_type}:${row.key}`}
        rows={pack.catalogue}
        columns={[
          { key: 'type', header: t('org.catalogue.type.column'), render: (row) => <span className="ent2-key">{row.master_type}</span> },
          { key: 'key', header: t('org.catalogue.key.column'), render: (row) => <span className="ent2-key">{row.key}</span> },
          { key: 'name', header: t('org.catalogue.name.column'), render: (row) => row.label },
          { key: 'parent', header: t('org.catalogue.parent.column'), render: (row) => row.parent_key ?? '–' },
        ]}
      />
    </SectionCard>
  );
}
