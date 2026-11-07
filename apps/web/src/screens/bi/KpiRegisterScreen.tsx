import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { CertPill } from './CertPill';
import { useKpiRegister } from './certification-hooks';
import { CERTIFICATION_PATH, dayOf } from './certification-model';
import type { RegisterKpi } from './kpi-register-model';
import './bi.css';
import './bi-kit.css';

type T = Translator['t'];

const versionText = (t: T, definition: RegisterKpi): string => (definition.version === 0 ? t('govc.bi.version.builtIn') : String(definition.version));
const lagText = (t: T, days: number | null): string => (days === null ? t('govc.bi.none') : t('govc.bi.register.lagDays', { days }));
const textOf = (t: T, value: string | null): string => (value === null || value === '' ? t('govc.bi.none') : value);

/**
 * BI-20: the KPI register (G0-4): one definition for each indicator (formula, numerator, denominator, what is left out, period, source, owner, how late it may be, version) and the certification of the version in force. The web,
 * the phone and the Excel file use these words and these digits. Read only: a definition changes by a rule of the governance store, and its certification is BI-19. A definition that is still a starting value of the platform
 * nobody confirmed says so.
 */
export default function KpiRegisterScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RegisterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegisterContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const register = useKpiRegister();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const data = register.data;
  const state = useScreenState({ isLoading: register.isLoading, error: data === undefined ? register.error : undefined, data, isEmpty: () => false });
  const stale = data !== undefined && register.isRefetchError;
  const needle = search.trim().toLowerCase();
  const rows = (data?.definitions ?? []).filter((definition) => needle === '' || definition.code.toLowerCase().includes(needle) || definition.name.toLowerCase().includes(needle));
  const detail = data?.definitions.find((definition) => definition.code === chosen);
  const columns = registerColumns(t, setChosen);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govc.bi.register.title')}</h1>
          <p>{t('govc.bi.register.subtitle')}</p>
        </div>
        <div className="mne-actions">
          <Link className="ui-button ui-button--outline" to={CERTIFICATION_PATH}>
            {t('govc.bi.register.certLink')}
          </Link>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('govc.bi.ctx.scope'), value: tenant?.name ?? t('govc.bi.ctx.scope.all') },
          { label: t('govc.bi.ctx.asOf'), value: data === undefined || data.asOf === '' ? t('govc.bi.ctx.none') : dayOf(data.asOf) },
          { label: t('govc.bi.ctx.count'), value: data === undefined ? t('govc.bi.ctx.none') : String(data.definitions.length) },
        ]}
        stale={stale}
        {...(register.dataUpdatedAt > 0 ? { asOf: new Date(register.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {stale ? (
          <div className="callout warning" role="status" data-testid="register-stale">
            <span>{t('govc.bi.cert.stale', { at: new Date(register.dataUpdatedAt).toLocaleString('vi-VN') })}</span>{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void register.refetch()}>
              {t('govc.bi.cert.retry')}
            </button>
          </div>
        ) : null}
        {data !== undefined && data.skipped > 0 ? (
          <p className="callout warning" role="status" data-testid="register-partial">
            {t('govc.bi.cert.partial', { count: data.skipped })}
          </p>
        ) : null}
        <FilterPanel applied={needle === '' ? 0 : 1}>
          <Field id="register-search" label={t('govc.bi.register.search')} error={undefined}>
            <input id="register-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </Field>
        </FilterPanel>
        <DataTable
          caption={t('govc.bi.register.table.aria')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.code}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          emptyKind={needle === '' ? 'none' : 'filtered'}
          onClearFilters={() => setSearch('')}
        />
        {detail === undefined ? null : <Detail definition={detail} onClose={() => setChosen(undefined)} />}
      </StateBoundary>
    </section>
  );
}

function registerColumns(t: T, open: (code: string) => void): DataTableColumn<RegisterKpi>[] {
  const none = t('govc.bi.none');
  return [
    {
      key: 'code',
      header: t('govc.bi.column.code'),
      pinned: true,
      render: (row) => (
        <>
          <strong>{row.code}</strong>
          {row.unverified ? (
            <p className="sub" data-testid="register-unverified">
              {t('govc.bi.register.unverified')}
            </p>
          ) : null}
        </>
      ),
    },
    { key: 'name', header: t('govc.bi.register.column.name'), render: (row) => row.name },
    { key: 'formula', header: t('govc.bi.register.column.formula'), render: (row) => row.formula },
    { key: 'numerator', header: t('govc.bi.register.column.numerator'), render: (row) => textOf(t, row.numerator) },
    { key: 'denominator', header: t('govc.bi.register.column.denominator'), render: (row) => textOf(t, row.denominator) },
    {
      key: 'exclusions',
      header: t('govc.bi.register.column.exclusions'),
      render: (row) =>
        row.exclusions.length === 0 ? (
          none
        ) : (
          <ul className="mne-lines">
            {row.exclusions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ),
    },
    { key: 'period', header: t('govc.bi.register.column.period'), render: (row) => textOf(t, row.period) },
    { key: 'source', header: t('govc.bi.register.column.source'), render: (row) => textOf(t, row.source) },
    { key: 'owner', header: t('govc.bi.register.column.owner'), render: (row) => textOf(t, row.owner) },
    { key: 'lag', header: t('govc.bi.register.column.lag'), align: 'right', render: (row) => lagText(t, row.allowedLagDays) },
    { key: 'version', header: t('govc.bi.column.version'), align: 'right', render: (row) => versionText(t, row) },
    {
      key: 'certification',
      header: t('govc.bi.register.column.certification'),
      render: (row) => (row.certification === null ? <span data-testid="register-no-cert">{t('govc.bi.register.noCertification')}</span> : <CertPill status={row.certification.status} />),
    },
    {
      key: 'detail',
      header: t('govc.bi.column.actions'),
      render: (row) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('govc.bi.register.detail.aria', { code: row.code })} onClick={() => open(row.code)}>
          {t('govc.bi.detail.open')}
        </button>
      ),
    },
  ];
}

/** The row detail: every field of the definition written in full, as the "i" of a number on a dashboard says it. */
function Detail({ definition, onClose }: { definition: RegisterKpi; onClose: () => void }) {
  const { t } = useTranslation();
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, [definition.code]);
  const certification = definition.certification;
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: 'name', label: t('govc.bi.register.column.name'), value: definition.name },
    { key: 'formula', label: t('govc.bi.register.column.formula'), value: definition.formula },
    { key: 'numerator', label: t('govc.bi.register.column.numerator'), value: textOf(t, definition.numerator) },
    { key: 'denominator', label: t('govc.bi.register.column.denominator'), value: textOf(t, definition.denominator) },
    { key: 'unit', label: t('govc.bi.register.column.unit'), value: textOf(t, definition.unit) },
    { key: 'period', label: t('govc.bi.register.column.period'), value: textOf(t, definition.period) },
    { key: 'source', label: t('govc.bi.register.column.source'), value: textOf(t, definition.source) },
    { key: 'owner', label: t('govc.bi.register.column.owner'), value: textOf(t, definition.owner) },
    { key: 'lag', label: t('govc.bi.register.column.lag'), value: lagText(t, definition.allowedLagDays) },
    { key: 'version', label: t('govc.bi.column.version'), value: versionText(t, definition) },
    { key: 'origin', label: t('govc.bi.register.column.origin'), value: definition.origin === 'RULE' ? t('govc.bi.register.origin.rule') : t('govc.bi.register.origin.default') },
  ];
  return (
    <SectionCard title={t('govc.bi.detail.title', { code: definition.code })} actions={<button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>{t('govc.bi.detail.close')}</button>}>
      <div data-testid="register-detail" role="region" aria-label={t('govc.bi.detail.title', { code: definition.code })} tabIndex={-1} ref={region}>
        <dl className="mne-lines">
          {rows.map((row) => (
            <div key={row.key} data-field={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          <div data-field="exclusions">
            <dt>{t('govc.bi.register.column.exclusions')}</dt>
            <dd>
              {definition.exclusions.length === 0 ? (
                t('govc.bi.none')
              ) : (
                <ul>
                  {definition.exclusions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div data-field="certification">
            <dt>{t('govc.bi.register.column.certification')}</dt>
            <dd>
              {certification === null ? (
                t('govc.bi.register.noCertification')
              ) : (
                <>
                  <CertPill status={certification.status} />{' '}
                  <span className="sub">{certification.certifiedBy === null ? t('govc.bi.register.certVersion', { version: certification.version }) : t('govc.bi.register.certBy', { version: certification.version, name: certification.certifiedBy, day: dayOf(certification.at) })}</span>
                </>
              )}
            </dd>
          </div>
        </dl>
        {definition.unverified ? (
          <p className="callout warning" data-testid="register-detail-unverified">
            {t('govc.bi.register.unverified')}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
