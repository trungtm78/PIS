import { Controller, Get, Inject } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GovernancePolicyPort, TenantDatabase, VendorIndependenceStore, VendorPerformanceStore, VendorRiskStore, securityFigures, subcontractFigures } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { todayOf } from './vendor-view';

const pct = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator * 1000) / denominator) / 10);

/**
 * The indicators of the controls of contractors (VND-2): the seven definitions registered in `KPI_DEFINITION` with the numerator and the denominator counted now by each part of the lane (independence, risk grades,
 * performance, bid security, payments to subcontractors). A definition keeps its formula, source and the unverified flag so that every figure on a screen can show them behind the "i".
 */
@Controller()
export class VendorControlFiguresController {
  private readonly rules = new GovernancePolicyPort();
  private readonly independence = new VendorIndependenceStore();
  private readonly risk = new VendorRiskStore();
  private readonly performance = new VendorPerformanceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('vendor/control-figures')
  @OperationId('getVendorControlFigures')
  async figures(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.getVendorControlFigures)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const counted = [
        ...(await this.independence.figures(tx, now)),
        ...(await this.risk.figures(tx, today)),
        ...(await this.performance.figures(tx, today)),
        ...(await securityFigures(tx, now)),
        ...(await subcontractFigures(tx, now)),
      ];
      const indicators = [];
      for (const figure of counted) {
        const rule = await this.rules.get(tx, 'KPI_DEFINITION', figure.code, today);
        if (rule === undefined) continue;
        indicators.push({
          code: figure.code,
          name: String(rule.params.name ?? figure.code),
          formula: rule.provenance?.formula ?? String(rule.params.formula ?? ''),
          source: String(rule.params.source ?? rule.provenance?.source ?? ''),
          unverified: rule.unverified,
          numerator: figure.numerator,
          denominator: figure.denominator,
          pct: String(rule.params.unit) === 'PERCENT' ? pct(figure.numerator, figure.denominator) : null,
        });
      }
      return { indicators, as_of: now.toISOString() };
    });
  }
}
