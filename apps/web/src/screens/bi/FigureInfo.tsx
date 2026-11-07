import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { useCertifications, useKpiRegister, FIGURE_META_STALE_MS } from './certification-hooks';
import { certStatusLabel } from './certification-labels';
import { definitionFromMetric, definitionFromRegister, registerFor } from './kpi-register-model';
import type { FigureDefinition } from './kpi-register-model';
import type { Metric } from './bi-model';
import { useMetrics } from './hooks';
import './bi-kit.css';

export interface FigureInfoProps {
  /** The metric the number is of: its code finds the definition in the KPI register; its formula, owner and revision are the fallback. */
  metric: Metric | undefined;
  /** The code of the number when the metric itself is not at hand (a code that is in the register still gets its "i"). */
  code?: string | undefined;
  /** The dataset the number is made from, when the screen knows it; with none, no data-quality flag is shown (nothing is invented). */
  datasetId?: string | null | undefined;
  datasetCode?: string | null | undefined;
  /** The period the figure is counted for, as the screen writes it. */
  period: string;
}

/**
 * What stands next to a number of BI (G0-4, G3-1): the "i" with the definition it is made by (the KPI register when it has the code, otherwise the definition of the metric the screen already has), and a text flag when the
 * dataset it is made from is not certified. The register and the certifications are read once and shared by every number on the page. A failed read leaves the number without the control rather than with a wrong one; a
 * refusal of the read (the person may not read the register) says nothing, and any other failure of the certification read says it could not be checked.
 */
export function FigureInfo({ metric, code, datasetId, datasetCode, period }: FigureInfoProps) {
  const { t } = useTranslation();
  const register = useKpiRegister({ quiet: true });
  const certifications = useCertifications({ enabled: datasetId !== undefined && datasetId !== null, staleMs: FIGURE_META_STALE_MS, quiet: true });
  const figureCode = metric?.code ?? code;
  const known = figureCode === undefined ? undefined : registerFor(register.data, figureCode);
  const sourceText = datasetCode === undefined || datasetCode === null ? t('govc.bi.info.source.snapshot', { period }) : t('govc.bi.info.source.dataset', { dataset: datasetCode, period });
  const definition: FigureDefinition | undefined = known !== undefined ? definitionFromRegister(known) : metric === undefined ? undefined : definitionFromMetric(metric, sourceText, t('govc.bi.none'));
  const labels = (name: string): InfoFormulaLabels => ({
    open: t('govc.bi.info.open', { name }),
    close: t('govc.bi.info.close'),
    formula: t('govc.bi.info.formula'),
    numerator: t('govc.bi.info.numerator'),
    denominator: t('govc.bi.info.denominator'),
    exclusions: t('govc.bi.info.exclusions'),
    source: t('govc.bi.info.source'),
    asOf: t('govc.bi.info.asOf'),
    owner: t('govc.bi.info.owner'),
    version: t('govc.bi.info.version'),
    unverified: t('govc.bi.register.unverified'),
  });
  const dataset = datasetId === undefined || datasetId === null ? undefined : certifications.data?.datasets.find((item) => item.key.toLowerCase() === datasetId.toLowerCase());
  const refused = certifications.error instanceof ApiError && certifications.error.status === 403;
  let flag: string | undefined;
  if (dataset !== undefined && dataset.status !== 'CERTIFIED') flag = t('govc.bi.figure.datasetNotCertified', { status: certStatusLabel(t, dataset.status) });
  else if (datasetId !== undefined && datasetId !== null && certifications.isError && !refused && dataset === undefined) flag = t('govc.bi.figure.unchecked');
  if (definition === undefined && flag === undefined) return null;
  return (
    <span className="bi-figure-info" data-testid="figure-info">
      {definition === undefined ? null : (
        <InfoFormula
          name={definition.name}
          formula={definition.formula}
          numerator={definition.numerator}
          denominator={definition.denominator}
          exclusions={definition.exclusions}
          source={definition.source === '' ? t('govc.bi.none') : definition.source}
          asOf={period}
          owner={definition.owner === '' ? t('govc.bi.none') : definition.owner}
          version={definition.from === 'METRIC' ? t('govc.bi.info.revision', { revision: definition.version }) : definition.builtIn ? t('govc.bi.version.builtIn') : t('govc.bi.info.versionOf', { version: definition.version })}
          unverified={definition.unverified}
          labels={labels(definition.name)}
        />
      )}
      {flag === undefined ? null : (
        <span data-testid="figure-flag">
          <StatusPill tone="warning">{flag}</StatusPill>
        </span>
      )}
    </span>
  );
}

/** The "i" of a number the screen knows only by the id of its metric (a widget of a dashboard): the metric is found in the registry the screens already read, and its dataset, when it names one, is the one checked. */
export function MetricFigureInfo({ metricId, metricCode, period }: { metricId: string; metricCode: string; period: string }) {
  const metrics = useMetrics();
  const metric = metrics.data?.find((item) => item.id === metricId);
  return <FigureInfo metric={metric} code={metricCode} datasetId={metric?.datasetId ?? null} period={period} />;
}
