import type { Metric } from './bi-model';
import type { Dataset } from './dataset-model';

/**
 * Which dataset serves a metric (BI-02): the server plans a metric query by the fields of the dataset the snapshot belongs to, so a tile must ask on a snapshot of a dataset that has every field the metric reads.
 * The kernel keeps these lists in the adapters of the query engine; that module reads `node:crypto` and cannot be bundled for the browser, so the screen keeps the names only, and a test compares them with the adapters.
 */
export const DATASET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'DS-DISB': ['GIAI_NGAN', 'GIAI_NGAN_BAO_CAO', 'KE_HOACH_TTG', 'KE_HOACH_DIA_PHUONG', 'KE_HOACH_TONG', 'CTMTQG', 'DU_AN', 'DON_VI'],
  'DS-CTR': [
    'CONTRACT_VALUE',
    'ACTIVE_VALUE',
    'ORIGINAL_VALUE',
    'APPROVED_CHANGE_DELTA',
    'WINNING_BID',
    'BID_VARIANCE',
    'REQUESTED',
    'ACCEPTED',
    'PAID',
    'ADVANCE_PAID',
    'ADVANCE_RECOVERED',
    'ADVANCE_OUTSTANDING',
    'RETENTION_WITHHELD',
    'RETENTION_RELEASED',
    'RETENTION_HELD',
    'GUARANTEE_REQUIRED',
    'GUARANTEE_VALID',
    'SINGLE_BIDDER',
    'BIDDER_KNOWN',
    'DAYS_LATE',
    'CONTRACT',
    'CONTRACTOR',
  ],
};

type Raw = Record<string, unknown>;

/** The operators of the second stage of a measure (shares, squared shares): they are computed over the groups of a dimension, so a query for them must name one. */
const SECOND_STAGE_OPS = ['sum_of_squares', 'top_n_sum', 'total_squared'];
/** The dimension a tile cuts by when the metric is of two stages: the parties the shares are shares of. */
export const TWO_STAGE_DIMENSION = 'contractor';

function hasSecondStage(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Raw;
  return (typeof record.op === 'string' && SECOND_STAGE_OPS.includes(record.op)) || (Array.isArray(record.args) && record.args.some((child) => hasSecondStage(child)));
}

/** The dimension a board tile must name for the metric, or none for a metric of one stage. */
export const tileDimensionOf = (metric: Metric): string | undefined => ([metric.expression, metric.numerator, metric.denominator].some((node) => hasSecondStage(node)) ? TWO_STAGE_DIMENSION : undefined);

/** The names of the fields an expression tree reads. */
export function fieldsOfNode(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Raw;
  if (record.op === 'field') return typeof record.name === 'string' ? [record.name] : [];
  return Array.isArray(record.args) ? record.args.flatMap((child) => fieldsOfNode(child)) : [];
}

/** The fields a metric reads: its expression, and the two sides of a ratio. */
export const fieldsOfMetric = (metric: Metric): string[] => [...new Set([metric.expression, metric.numerator, metric.denominator].flatMap((node) => fieldsOfNode(node)))];

/** The dataset that serves a metric: the one the metric names, else the first of the catalogue that has every field it reads; none when no registered dataset does (the EVM metrics of a project). */
export function servingDataset(metric: Metric, datasets: readonly Dataset[]): Dataset | undefined {
  if (metric.datasetId !== null) {
    const named = datasets.find((dataset) => dataset.id === metric.datasetId);
    if (named !== undefined) return named;
  }
  const fields = fieldsOfMetric(metric);
  if (fields.length === 0) return undefined;
  return datasets.find((dataset) => {
    const has = DATASET_FIELDS[dataset.code];
    return has !== undefined && fields.every((field) => has.includes(field));
  });
}
