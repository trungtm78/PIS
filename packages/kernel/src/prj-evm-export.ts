import type { ExportColumn, ExportDocument } from './dis-export.ts';
import type { EvmFigures, SCurve } from './prj-evm.ts';
import { message } from './messages.ts';

/**
 * The workbook of the S-curve (G1-5): the same figures the screen draws, as a table a person can open in a spreadsheet, with the day of the view, the baseline and the formula that were used. A figure that could not
 * be known is an empty cell and the notice says why; it is never written as a zero. Pure function of its input.
 */
export const SCURVE_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'day', label: message('prj.scurve.export.column.day'), numeric: false },
  { key: 'pv_v0_vnd', label: message('prj.scurve.export.column.pv_v0_vnd'), numeric: true },
  { key: 'pv_current_vnd', label: message('prj.scurve.export.column.pv_current_vnd'), numeric: true },
  { key: 'ev_vnd', label: message('prj.scurve.export.column.ev_vnd'), numeric: true },
  { key: 'ac_vnd', label: message('prj.scurve.export.column.ac_vnd'), numeric: true },
];

export interface SCurveExportInput {
  projectCode: string;
  curve: SCurve;
  figures: EvmFigures;
  /** The version of the baseline the current line of the curve follows. */
  baselineVersion: number | null;
  /** LIVE for figures read now, FROZEN for the figures of a closed period. */
  source: 'LIVE' | 'FROZEN';
}

export function buildSCurveExport(input: SCurveExportInput): ExportDocument {
  const { figures, curve } = input;
  const header = [
    { key: 'project', label: message('prj.scurve.export.header.project'), value: input.projectCode },
    { key: 'as_of', label: message('prj.scurve.export.header.as_of'), value: curve.asOf },
    { key: 'baseline', label: message('prj.scurve.export.header.baseline'), value: input.baselineVersion === null ? '' : `v${input.baselineVersion}` },
    { key: 'eac_method', label: message('prj.scurve.export.header.eac_method'), value: figures.eacMethod },
    { key: 'status', label: message('prj.scurve.export.header.status'), value: figures.status },
    { key: 'cpi', label: message('prj.scurve.export.header.cpi'), value: figures.cpi ?? '' },
    { key: 'spi', label: message('prj.scurve.export.header.spi'), value: figures.spi ?? '' },
    { key: 'eac', label: message('prj.scurve.export.header.eac'), value: figures.eacVnd ?? '' },
    { key: 'source', label: message('prj.scurve.export.header.source'), value: input.source },
  ];
  const reasons = [...new Set([...figures.missing, ...curve.missing])];
  return {
    title: message('prj.scurve.export.title', { project: input.projectCode }),
    header,
    columns: SCURVE_EXPORT_COLUMNS,
    rows: curve.points.map((point) => [point.day, point.pvV0Vnd, point.pvCurrentVnd, point.evVnd ?? '', point.acVnd ?? '']),
    notice: reasons.length === 0 ? null : message('prj.scurve.export.notice.insufficient', { reasons: reasons.join(', ') }),
  };
}
