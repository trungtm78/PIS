import { PERMISSIONS } from '@machvon/contracts';
import { ReportStore } from '@machvon/db';
import type { ProvinceFactsReader } from '@machvon/db';
import { COMMITTEE_PACK_CODE, COMMITTEE_PACK_LAYOUT, DomainError, defaultBasisOf, packDatasetsOf, packFeedLine } from '@machvon/kernel';
import type { KpiDefinition, ReportFigure, ReportFillData, ReportIndicatorDefinition, SnapshotRevisionRef } from '@machvon/kernel';
import type { ProviderContext, ProviderResult, ReportFigureProvider } from '../reports/figure-provider';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { ReportFormRegistry } from '../reports/form-registry';
import { buildBlankTemplate } from '../reports/blank-template';
import { CommitteeWorkspaceService } from './committee-service';

export const COMMITTEE_PACK_PROVIDER = 'COMMITTEE_PACK';

const definitionOf = (definition: KpiDefinition): ReportIndicatorDefinition => ({
  code: definition.code,
  name: definition.name,
  unit: definition.unit,
  decimals: definition.decimals,
  period: definition.period,
  version: definition.version,
  formula: definition.formula,
  source: definition.source,
  unverified: definition.unverified,
});

/**
 * The figures of the meeting pack of the committee (lane BAN-1): the same read as the screen of the workspace (`CommitteeWorkspaceService`), so the file and the screen give one number for one indicator. A province
 * with no facts gets the form with empty cells and the line "no facts", never zeros. The pack covers the whole tenant, so only someone with authority over the whole tenant may issue it.
 */
export class CommitteePackProvider implements ReportFigureProvider {
  readonly id = COMMITTEE_PACK_PROVIDER;
  readonly wholeTenant = true;
  private readonly service: CommitteeWorkspaceService;
  private readonly reports = new ReportStore();

  constructor(reader?: ProvinceFactsReader) {
    this.service = new CommitteeWorkspaceService(reader);
  }

  async load(context: ProviderContext): Promise<ProviderResult> {
    // The figures are province-wide and confidential: the permissions of the report engine alone do not open them.
    if (!holdsOnWholeTenant(context.access, PERMISSIONS.getCommitteeWorkspace)) throw new DomainError('SCOPE_DENIED', 403);
    const day = context.period.day ?? context.today;
    const around = await context.database.withTenant(context.tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: day > context.today ? context.today : day });
      const org = (await tx.query<{ name: string }>('select name from machvon.organization_unit where parent_id is null and valid_until is null order by valid_from, id limit 1'))[0]?.name ?? '';
      const reference = read.facts.feed.reference;
      const revision = reference === null || read.facts.feed.basis !== 'DIS_SNAPSHOT' ? 0 : await this.reports.snapshotRevision(tx, reference);
      return { read, org, revision };
    });
    const { read } = around;
    const definitions: Record<string, ReportIndicatorDefinition> = {};
    for (const [code, definition] of read.definitions) if (code.startsWith('COMMITTEE_')) definitions[code] = definitionOf(definition);
    const figures: ReportFigure[] = [];
    for (const figure of read.figures) {
      const definition = definitions[figure.metric_code];
      if (definition === undefined) continue;
      figures.push({ code: figure.metric_code, basis: defaultBasisOf(definition.period), value: figure.value, flags: figure.flags, asOf: read.workspace.asOf });
    }
    const empty = read.workspace.feed.empty;
    const data: ReportFillData = {
      period: context.period,
      locale: 'vi',
      meta: { ORG_NAME: around.org, FEED_LINE: packFeedLine(empty ? null : read.workspace.asOf, read.facts.feed.basis, read.facts.feed.reference) },
      definitions,
      figures,
      datasets: packDatasetsOf(read.workspace, read.tracker.units, read.attention.slice(0, read.policy.params.attentionTopN)),
    };
    const snapshot: SnapshotRevisionRef | null = read.facts.feed.reference === null || read.facts.feed.basis !== 'DIS_SNAPSHOT' ? null : { snapshotId: read.facts.feed.reference, revision: around.revision, cutoff: read.workspace.asOf };
    return { data, snapshot };
  }
}

/** Registers the meeting pack and its provider in the registry of the report engine. Calling it again changes nothing. */
export function registerCommitteeReportForm(registry: ReportFormRegistry, reader?: ProvinceFactsReader): void {
  registry.registerProvider(new CommitteePackProvider(reader));
  registry.guard(COMMITTEE_PACK_CODE, PERMISSIONS.getCommitteeWorkspace);
  registry.register({
    edition: 'public',
    layout: COMMITTEE_PACK_LAYOUT,
    narrative: null,
    receiver: 'INTERNAL',
    periodKind: 'AS_OF',
    dataSource: 'LIVE',
    provider: COMMITTEE_PACK_PROVIDER,
    templates: async () => ({ xlsx: await buildBlankTemplate(COMMITTEE_PACK_LAYOUT), docx: null }),
  });
}
