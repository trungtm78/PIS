import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CONFIG_CODE_PREFIX, DomainError, REPORT_LAYOUT_RULE_TYPE, compileLayoutConfig, formDocumentOf, illustrativeLayoutData, layoutConfigOf, previewOf, validateRuleParams, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, FormPeriod } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { indicatorDefinitionsOf } from './configured-forms';

const PREVIEW_CODE = `${CONFIG_CODE_PREFIX}PREVIEW`;
/** The period the preview is shown for when the caller names none: a fixed one, so the same layout always previews the same. */
const DEFAULT_PERIODS: Record<string, FormPeriod> = {
  MONTH: { kind: 'MONTH', year: 2026, index: 10 },
  QUARTER: { kind: 'QUARTER', year: 2026, index: 3 },
  HALF_YEAR: { kind: 'HALF_YEAR', year: 2026, index: 1 },
  YEAR: { kind: 'YEAR', year: 2026 },
  AS_OF: { kind: 'AS_OF', year: 2026, day: '2026-10-31' },
};

/**
 * The preview of a layout while it is being edited (ENT-4b, R23): the params go through the same schema and cross-field rules as a rule of the type `REPORT_LAYOUT`, are compiled to the layout the report engine would
 * use, and are filled with invented, labelled data, so the user sees the form before anything is stored. Nothing is written except the audit line. A layout that does not pass is answered with `valid: false` and the first
 * field it is refused for (an editor shows it next to the field), not with an error.
 */
@Controller()
export class LayoutPreviewController {
  @Post('report-engine/layout-previews')
  @HttpCode(200)
  @OperationId('previewReportLayout')
  @Command({ operation: 'previewReportLayout' })
  async preview(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RptLayoutPreviewRequest']): Promise<Schemas['RptLayoutPreview']> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.generateReport)) throw new DomainError('SCOPE_DENIED', 403);
    const refused = (problem: string): Schemas['RptLayoutPreview'] => ({ valid: false, problem, form_name: null, status: null, datasets: [], preview: null, issues: [] });
    let result: Schemas['RptLayoutPreview'];
    try {
      const params = validateRuleParams(REPORT_LAYOUT_RULE_TYPE, body.params);
      const config = layoutConfigOf(params);
      const today = vietnamDateOf(new Date());
      const definitions = await indicatorDefinitionsOf(scope.tx, today);
      const names = Object.fromEntries(Object.entries(definitions).map(([code, one]) => [code, one.name]));
      const compiled = compileLayoutConfig(PREVIEW_CODE, 'preview', config, { names });
      const period: FormPeriod = body.period === undefined ? (DEFAULT_PERIODS[config.period_kind] as FormPeriod) : { kind: body.period.kind, year: body.period.year, ...(body.period.index === undefined ? {} : { index: body.period.index }), ...(body.period.day === undefined ? {} : { day: body.period.day }) };
      if (period.kind !== config.period_kind) throw new DomainError('VALIDATION_FAILED', 422, 'period_kind');
      const document = formDocumentOf(compiled.layout, null, illustrativeLayoutData(config, period, definitions));
      const shown = previewOf(document.grid, document.narrative);
      result = {
        valid: true,
        problem: null,
        form_name: compiled.layout.name,
        status: compiled.layout.status,
        datasets: compiled.datasets,
        preview: { columns: shown.columns, rows: shown.rows, row_count: shown.rowCount, truncated: shown.truncated, narrative: shown.narrative, stamp: shown.stamp },
        issues: document.grid.issues.map((one) => ({ ref: one.ref, code: one.code, detail: one.detail })),
      };
    } catch (failure) {
      if (!(failure instanceof DomainError) || (failure.code !== 'GOVERNANCE_RULE_PARAMS_INVALID' && failure.code !== 'VALIDATION_FAILED')) throw failure;
      result = refused(failure.detail ?? 'params');
    }
    await scope.audit({ action: 'rpt.layout_previewed', resourceType: 'report_layout', resourceId: scope.tenant.tenantId, classification: 'INTERNAL', diff: { valid: result.valid, problem: result.problem } });
    return result;
  }
}
