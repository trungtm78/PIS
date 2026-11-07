import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { inTreeOrder } from './catalogues';
import { fieldProblemMessage, recordStatusLabel, recordStatusTone } from './labels';
import { isCalendarDate, recordLink } from './model';
import { STRUCTURES } from './structure';
import type { StructureConfig, StructureContext } from './structure';
import { useConversions, useRecordsAsOf, useStructureAsOf } from './succession-hooks';
import { vietnamToday } from './succession-model';
import { structureStateLabel, successionKindLabel } from './succession-labels';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './mdm.css';
import { StatusPill } from '../../ui';

const DETAIL_PATH = '/mdm/mdm-27';
const SUCCESSION_PATH = '/mdm/mdm-37';
const TREE_INDENT_PX = 16;
const NEVER_EMPTY = (): boolean => false;

/**
 * MDM-02 and MDM-03: the areas and the agencies as they stood on a date the person chooses, each entry with the entry that took over from
 * it and the kind and legal basis of that succession (ST-MDM-009). An entry that is not in force on the date is listed dimmed with the
 * state it was in; the structure itself is changed in MDM-37.
 */
export default function StructureScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  const config = STRUCTURES[route.id];
  if (config === undefined) throw new Error(`screen ${route.id} is not a structure screen`);
  // The date and the entries belong to one tenant: a switch starts the screen over.
  return <StructureContent key={`${tenantId ?? 'none'}:${route.id}`} route={route} config={config} />;
}

function StructureContent({ route, config }: ScreenProps & { config: StructureConfig }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(() => vietnamToday());
  const [onlyInForce, setOnlyInForce] = useState(false);
  const [inspected, setInspected] = useState<string | undefined>(undefined);
  const valid = isCalendarDate(chosen);
  // A date that is not a date is not read: the page keeps the entries of the last date and the field says what is wrong.
  const day = valid ? chosen : vietnamToday();

  const entries = useRecordsAsOf(config.types, day);
  const records = useMemo(() => entries.data ?? [], [entries.data]);
  // Only an entry with no version in force on the date can have been handed over by then.
  const candidates = useMemo(() => records.filter((record) => record.versionId === null).map((record) => record.id), [records]);
  const conversions = useConversions(candidates, day);
  const state = useScreenState({ isLoading: entries.isLoading || conversions.isLoading, error: entries.error ?? conversions.error, data: records, isEmpty: NEVER_EMPTY });

  const context = useMemo<StructureContext>(
    () => ({
      byId: new Map(records.map((record) => [record.id, record])),
      successorsOf: (record) => conversions.edges.filter((edge) => edge.predecessorRecordId === record.id),
      predecessorsOf: (record) => conversions.edges.filter((edge) => edge.successorRecordId === record.id),
      kind: (edge) => successionKindLabel(t, edge.kind),
      nameOf: (record) => record.label ?? conversions.edges.find((edge) => edge.predecessorRecordId === record.id)?.predecessorLabel ?? '',
    }),
    [records, conversions.edges, t],
  );
  const stateOf = (versionId: string | null, edges: number): 'IN_FORCE' | 'SUCCEEDED' | 'NOT_IN_FORCE' => (versionId !== null ? 'IN_FORCE' : edges > 0 ? 'SUCCEEDED' : 'NOT_IN_FORCE');

  const shown = records.filter((record) => !onlyInForce || record.versionId !== null);
  const rows = config.tree ? inTreeOrder(shown) : [...shown].sort((left, right) => left.businessKey.localeCompare(right.businessKey)).map((record) => ({ record, depth: 0 }));

  const refetch = (): void => void Promise.all([entries.refetch(), conversions.refetch()]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t(`mdm.${config.slug}.page.title`)}</h1>
          <p>{t(`mdm.${config.slug}.page.subtitle`)}</p>
        </div>
        <div className="row-actions">
          <Link to={SUCCESSION_PATH}>{t('mdm.structure.succession.link')}</Link>
        </div>
      </div>
      <form className="card mdm-filters" role="search" aria-label={t('mdm.structure.filter.aria')} onSubmit={(event) => event.preventDefault()}>
        <Field id="structure-date" label={t('mdm.structure.date.label')} error={valid ? undefined : fieldProblemMessage(t, 'invalidDate')} hint={t('mdm.structure.date.hint')}>
          <input id="structure-date" type="date" value={chosen} aria-invalid={!valid} onChange={(event) => setChosen(event.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={onlyInForce} onChange={(event) => setOnlyInForce(event.target.checked)} />
          {t('mdm.structure.onlyInForce.label')}
        </label>
      </form>
      <StateBoundary state={state} onRetry={refetch}>
        <div className="card" data-as-of={day}>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-structure">
              {t('mdm.structure.empty.text')}
            </p>
          ) : (
            <KitTable caption={t('w2mdm.structure.table.caption')}>
              <thead>
                <tr>
                  {config.columns.map((item) => (
                    <th key={item.key}>{t(`mdm.structure.${item.key}.column`)}</th>
                  ))}
                  <th>{t('mdm.structure.state.column')}</th>
                  <th>
                    {t('mdm.structure.actions.column')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ record, depth }) => {
                  const edges = context.successorsOf(record).length;
                  const standing = stateOf(record.versionId, edges);
                  return (
                    <tr key={record.id} data-record-id={record.id} data-key={record.businessKey} data-state={standing} className={standing === 'IN_FORCE' ? undefined : 'muted'}>
                      {config.columns.map((item, index) => (
                        <td key={item.key} data-column={item.key} style={index === 0 && depth > 0 ? { paddingInlineStart: depth * TREE_INDENT_PX } : undefined}>
                          {item.key === 'key' ? <code>{item.read(record, context)}</code> : item.read(record, context)}
                        </td>
                      ))}
                      <td>
                        <StatusPill tone={standing === 'IN_FORCE' ? 'success' : standing === 'SUCCEEDED' ? 'neutral' : recordStatusTone(record.status)}>
                          {standing === 'IN_FORCE' ? structureStateLabel(t, 'IN_FORCE') : standing === 'SUCCEEDED' ? structureStateLabel(t, 'SUCCEEDED') : recordStatusLabel(t, record.status)}
                        </StatusPill>
                      </td>
                      <td className="row-actions">
                        <button type="button" aria-pressed={inspected === record.id} onClick={() => setInspected(inspected === record.id ? undefined : record.id)}>
                          {t('mdm.structure.inspect.action')}
                        </button>
                        <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.structure.open.action')}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </KitTable>
          )}
          <p className="sub" data-testid="count">
            {t('mdm.structure.count.text', { count: rows.length })}
          </p>
        </div>
        {inspected === undefined ? null : <Inspection recordId={inspected} date={day} />}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.structure.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** One entry as it stood on the date: its version, the structure date it belongs to, and the entries of that day's structure it converts to. */
function Inspection({ recordId, date }: { recordId: string; date: string }) {
  const { t } = useTranslation();
  const reading = useStructureAsOf(recordId, date);
  const view = reading.data;
  return (
    <section className="card" aria-label={t('mdm.structure.inspect.title')} data-testid="inspection">
      <h2>{t('mdm.structure.inspect.title')}</h2>
      {reading.isError ? (
        <p className="callout warning" role="alert">
          {t('mdm.structure.inspect.error')}
        </p>
      ) : view === undefined || view === null ? (
        <p className="muted">{t('mdm.structure.inspect.loading')}</p>
      ) : (
        <>
          <dl className="mdm-facts">
            <dt>{t('mdm.structure.inspect.entry.label')}</dt>
            <dd>
              <code>{view.businessKey}</code> {view.version?.label ?? ''}
              {view.version === null ? null : <span className="sub"> {t('mdm.structure.inspect.revision.text', { revision: view.version.revision })}</span>}
            </dd>
            <dt>{t('mdm.structure.inspect.state.label')}</dt>
            <dd data-testid="inspect-state">{structureStateLabel(t, view.state)}</dd>
            <dt>{t('mdm.structure.inspect.structureDate.label')}</dt>
            <dd data-testid="inspect-structure-date">{view.structureDate ?? ''}</dd>
          </dl>
          <h3>{t('mdm.structure.inspect.targets.title')}</h3>
          <ul className="plain" data-testid="inspect-targets">
            {view.targets.map((target) => (
              <li key={target.recordId} data-key={target.businessKey}>
                <code>{target.businessKey}</code> {target.version?.label ?? ''}
                {target.kind === null ? null : <StatusPill tone="success">{target.kind}</StatusPill>}
                <span className="sub"> {t('mdm.succession.share.text', { share: target.sharePct })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
