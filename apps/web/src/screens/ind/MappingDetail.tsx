import { useEffect, useRef } from 'react';
import { useTranslation } from '../../i18n';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { GovernanceLink, OriginBadge, StateNote, VersionTable } from './ind-components';
import { useMappingDetail } from './ind-hooks';
import { layoutLabel, mappingProblemLabel, numberFormatLabel, scaleLabel } from './ind-labels';
import { DASH, vietnamDateTime } from './ind-model';
import type { Mapping, MappingLine } from './ind-model';
import './ind.css';

/** The columns (or the rows) a form is read through: which header or label of the file is which indicator, in which unit the sheet is written, and whether the file must have it. */
export function LinesTable({ mapping }: { mapping: Mapping }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<MappingLine>> = [
    { key: 'source', header: mapping.layout === 'COLUMNS' ? t('ind.map.line.column') : t('ind.map.line.row'), pinned: true, render: (row) => row.source },
    { key: 'indicator', header: t('ind.map.line.indicator'), render: (row) => row.indicator },
    { key: 'scale', header: t('ind.map.line.scale'), render: (row) => scaleLabel(t, row.scale) },
    { key: 'required', header: t('ind.map.line.required'), render: (row) => (row.required ? t('ind.map.line.requiredYes') : t('ind.map.line.requiredNo')) },
  ];
  return (
    <div data-testid="mapping-lines">
      <DataTable caption={t('ind.map.lines.caption')} columns={columns} rows={mapping.lines} rowKey={(row) => row.indicator} rowAttrs={(row) => ({ 'data-indicator': row.indicator })} />
    </div>
  );
}

/** What is wrong with a mapping against the dictionary: a line that names an indicator nobody defined or one the platform computes; such a mapping reads no file. */
export function ProblemList({ mapping }: { mapping: Mapping }) {
  const { t } = useTranslation();
  if (mapping.problems.length === 0) return null;
  return (
    <div className="callout warning" role="alert" data-testid="mapping-problems">
      <p>{t('ind.map.problems.title')}</p>
      <ul>
        {mapping.problems.map((problem) => (
          <li key={`${problem.line}:${problem.code}`} data-problem={problem.code}>
            {t('ind.map.problems.line', { n: problem.line + 1 })} {mappingProblemLabel(t, problem.code, problem.indicator)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One mapping (IND-03): the form it reads, the lines, the problems, and every version with who made, submitted and approved it. A mapping is changed through the governance rules, never here. */
export function MappingDetail({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useMappingDetail(code);
  const heading = useRef<HTMLDivElement>(null);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.data === undefined ? detail.error : undefined, data: detail.data ?? null, isEmpty: () => false });
  const data = detail.data;
  useEffect(() => {
    heading.current?.focus();
  }, [code]);
  const title = data === undefined ? t('ind.map.detail.titlePlain') : t('ind.map.detail.title', { name: data.mapping.name });
  return (
    <SectionCard
      title={title}
      actions={
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('ind.map.detail.close')}
        </button>
      }
    >
      <div data-testid="mapping-detail" role="group" aria-label={title} aria-live="polite" tabIndex={-1} ref={heading}>
        <StateNote
          state={state === 'default' && data === undefined ? 'error' : state}
          name="mapping-detail"
          texts={{ loading: t('ind.map.detail.loading'), denied: t('ind.map.detail.denied'), error: t('ind.map.detail.error') }}
          onRetry={() => void detail.refetch()}
        />
        {state === 'default' && data !== undefined ? (
          <>
            <p className="ind-chips">
              <OriginBadge origin={data.mapping.origin} unverified={data.mapping.unverified} />
              <StatusPill tone={data.mapping.active ? 'success' : 'neutral'}>{data.mapping.active ? t('ind.map.state.active') : t('ind.map.state.template')}</StatusPill>
              {data.asOf === null ? null : <span className="sub">{t('ind.map.detail.asOf', { time: vietnamDateTime(data.asOf) })}</span>}
            </p>
            {data.mapping.active ? null : (
              <p className="callout warning" role="status" data-testid="mapping-template-note">
                {t('ind.map.detail.templateNote')}
              </p>
            )}
            <dl className="ind-facts" data-testid="mapping-facts">
              <div>
                <dt>{t('ind.map.detail.code')}</dt>
                <dd>{data.mapping.code}</dd>
              </div>
              <div>
                <dt>{t('ind.map.detail.layout')}</dt>
                <dd>{layoutLabel(t, data.mapping.layout)}</dd>
              </div>
              <div>
                <dt>{t('ind.map.detail.numberFormat')}</dt>
                <dd>{numberFormatLabel(t, data.mapping.numberFormat)}</dd>
              </div>
              {data.mapping.layout === 'COLUMNS' ? (
                <>
                  <div>
                    <dt>{t('ind.map.detail.projectColumn')}</dt>
                    <dd>{data.mapping.projectColumn ?? DASH}</dd>
                  </div>
                  <div>
                    <dt>{t('ind.map.detail.periodColumn')}</dt>
                    <dd>{data.mapping.periodColumn ?? DASH}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>{t('ind.map.detail.labelColumn')}</dt>
                    <dd>{data.mapping.labelColumn ?? DASH}</dd>
                  </div>
                  <div>
                    <dt>{t('ind.map.detail.valueColumn')}</dt>
                    <dd>{data.mapping.valueColumn ?? DASH}</dd>
                  </div>
                </>
              )}
            </dl>
            <ProblemList mapping={data.mapping} />
            <LinesTable mapping={data.mapping} />
            <h3>{t('ind.map.versions.title')}</h3>
            <VersionTable versions={data.versions} caption={t('ind.map.versions.caption')} />
            <GovernanceLink />
          </>
        ) : null}
      </div>
    </SectionCard>
  );
}
