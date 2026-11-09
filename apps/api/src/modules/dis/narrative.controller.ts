import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DirDirectiveStore, DisPeriodStore, DisReportStore, EntNarrativeStore, IndEntryRuleStore, REPORT_RESOURCE, TenantDatabase, directiveScope, projectScope } from '@machvon/db';
import {
  DomainError,
  NARRATIVE_FIELDS,
  NARRATIVE_IMPORT_MAPPING,
  NARRATIVE_MANDATORY_FACTS,
  NARRATIVE_IMPORT_COLUMNS,
  directiveLine,
  inheritNarrative,
  inheritanceHashes,
  isNarrativeField,
  narrativeEntryValues,
  unchangedInherited,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, EnterpriseNarrative, NarrativeField, NarrativeInheritance, NarrativeInput, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { enforceNarrativeEntry } from '../../ind-entry-guard';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertPeriodReach } from './period-gate';
import { NARRATIVE_TEMPLATE_CONTENT_TYPE, buildNarrativeTemplate } from './narrative-template';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportNarrativeContext;
const SEE_PERMISSION = PERMISSIONS.getReportRevision;
const EDIT_PERMISSION = PERMISSIONS.inheritReportNarrative;
const IMPORT_PERMISSION = PERMISSIONS.getReportNarrativeTemplate;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const emptyNarrative = (): NarrativeInput => ({ resultsText: null, causesText: null, solutionsText: null, proposalsText: null, linkedIssueIds: [] });

const violationView = (one: { ruleCode: string; check: string; fields: string[]; message: string }): Record<string, unknown> => ({ rule_code: one.ruleCode, check: one.check, fields: one.fields, message: one.message });

/**
 * The structured narrative of a period, the parts of it that are not a field of the report (ENT-3b; HSKT DL.01, CN.02, CN.03): what a person needs in front of them to write it (the standard causes, the directives
 * of the leadership meetings of the period, the previous period's words that can be inherited, the approved rules), the explicit copy of the previous period with its trace, and the Excel template for entering the
 * narratives of a period in one file. The fields themselves are written with the report (`narrative.enterprise` of the draft).
 */
@Controller()
export class ReportNarrativeController {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();
  private readonly narratives = new EntNarrativeStore();
  private readonly directives = new DirDirectiveStore();
  private readonly rules = new IndEntryRuleStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('reports/:id/narrative-context')
  @OperationId('getReportNarrativeContext')
  async context(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const detail = await this.reports.find(tx, id, projectScope(access, READ_PERMISSION, now));
      if (detail === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const block = detail.narrative?.enterprise;
      const view = await this.directives.forReport(tx, directiveScope(access, PERMISSIONS.getDirective, now), { from: detail.period.startDate, to: detail.period.endDate }, { projectId: detail.project.id });
      const rolled = new Set((block?.directiveRefs ?? []).map((ref) => ref.id));
      const previous = await this.narratives.previousOf(tx, id);
      const verdict = await this.rules.check(tx, { surface: 'PERIOD_NARRATIVE', facts: { values: narrativeEntryValues(block ?? null), periodStatus: detail.period.status }, asOf: vietnamDateOf(now) });
      return {
        as_of: now.toISOString(),
        report_id: id,
        fields: [...NARRATIVE_FIELDS],
        causes: await this.narratives.causes(tx),
        directives: {
          from: view.from,
          to: view.to,
          truncated: view.truncated,
          items: view.items.map((item) => ({
            id: item.id,
            code: item.code,
            meeting_date: item.meeting.meetingDate,
            text: item.text,
            assignee_unit: item.assigneeUnit.name,
            due_on: item.dueOnAtEnd,
            status_at_end: item.statusAtEnd,
            last_note: item.lastNote,
            line: directiveLine({ id: item.id, code: item.code, meetingDate: item.meeting.meetingDate, text: item.text, assigneeUnitName: item.assigneeUnit.name, dueOnAtEnd: item.dueOnAtEnd, statusAtEnd: item.statusAtEnd, lastNote: item.lastNote }),
            rolled_up: rolled.has(item.id),
          })),
        },
        previous:
          previous === undefined
            ? null
            : { report_id: previous.reportId, period_code: previous.periodCode, status: previous.status, fields: NARRATIVE_FIELDS.filter((field) => previous.block.fields[field] !== null), cause_codes: [...previous.block.causeCodes] },
        inheritance:
          block?.inheritance === undefined
            ? null
            : { from_report_id: block.inheritance.fromReportId, from_period_id: block.inheritance.fromPeriodId, at: block.inheritance.at, by: block.inheritance.by, fields: Object.keys(block.inheritance.hashes) },
        unchanged_inherited: block === undefined ? [] : unchangedInherited(block, block.inheritance),
        mandatory: [...NARRATIVE_MANDATORY_FACTS],
        verdict: { blocking: verdict.blocking.map(violationView), warnings: verdict.warnings.map(violationView) },
      };
    });
  }

  @Post('reports/:id/narrative-inheritance')
  @HttpCode(200)
  @OperationId('inheritReportNarrative')
  @Command({ operation: 'inheritReportNarrative', versioned: true })
  async inherit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['InheritReportNarrative']): Promise<CommandResult> {
    const now = this.clock();
    const wanted = this.fieldsOf(body.fields);
    const head = await this.reports.lock(scope.tx, id, projectScope(access, SEE_PERMISSION, now), projectScope(access, EDIT_PERMISSION, now), scope.expectedVersion ?? 0);
    // What was handed in is not edited; a closed period takes nothing unless an approved reopening names the project.
    this.reports.assertEditable(head);
    await assertPeriodReach(scope.tx, this.reports, this.periods, head.projectId, head.periodId, access, EDIT_PERMISSION, now);
    const judged = await this.periods.judge(scope.tx, head.periodId, head.projectId, now);
    const previous = await this.narratives.previousOf(scope.tx, id);
    if (previous === undefined) throw new DomainError('NARRATIVE_NOTHING_TO_INHERIT', 409, 'previous');
    // Only the fields asked for and the causes that are still on the list are copied; the directives of another period never are.
    const unknown = new Set(await this.narratives.unknownCodes(scope.tx, previous.block.causeCodes));
    const source: EnterpriseNarrative = {
      ...previous.block,
      fields: Object.fromEntries(NARRATIVE_FIELDS.map((field) => [field, wanted.includes(field) ? previous.block.fields[field] : null])) as EnterpriseNarrative['fields'],
      causeCodes: body.include_causes === false ? [] : previous.block.causeCodes.filter((code) => !unknown.has(code)),
    };
    const held = await this.reports.narrativeOf(scope.tx, id);
    const result = inheritNarrative(source, held?.enterprise ?? null);
    if (result.copied.length === 0) throw new DomainError('NARRATIVE_NOTHING_TO_INHERIT', 409, 'fields');
    const earlier = held?.enterprise?.inheritance;
    const trace: NarrativeInheritance = {
      fromReportId: previous.reportId,
      fromPeriodId: previous.periodId,
      at: now.toISOString(),
      by: scope.tenant.membershipId,
      hashes: { ...(earlier?.fromReportId === previous.reportId ? earlier.hashes : {}), ...inheritanceHashes(result.block, result.copied) },
    };
    const narrative: NarrativeInput = { ...(held ?? emptyNarrative()), enterprise: { ...result.block, inheritance: trace } };
    await enforceNarrativeEntry(scope, { resourceId: id, block: narrative.enterprise ?? null, periodStatus: judged.reopen !== null ? 'REOPENED' : judged.period.status, phase: 'SAVE', now });
    const saved = await this.reports.saveNarrative(scope.tx, head, narrative, scope.tenant.membershipId);
    await scope.audit({
      action: 'dis.report_narrative_inherited',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: { from_report_id: previous.reportId, from_period_code: previous.periodCode, copied_fields: result.copied, payload_hash: saved.payloadHash, version: saved.version },
    });
    return commandResult(scope, 'DRAFT', saved.version, id);
  }

  @Get('report-narrative-template')
  @OperationId('getReportNarrativeTemplate')
  async template(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('period_id') periodId?: unknown): Promise<Record<string, unknown>> {
    const now = this.clock();
    if (periodId !== undefined && (typeof periodId !== 'string' || !UUID.test(periodId))) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
    const { projects, causes } = await this.database.withTenant(tenant, async (tx) => ({
      projects: periodId === undefined ? [] : await this.narratives.draftProjects(tx, periodId.toLowerCase(), projectScope(access, IMPORT_PERMISSION, now)),
      causes: await this.narratives.causes(tx),
    }));
    const bytes = await buildNarrativeTemplate({ projects, causes });
    return {
      file_name: 'narrative-template.xlsx',
      content_type: NARRATIVE_TEMPLATE_CONTENT_TYPE,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_base64: Buffer.from(bytes).toString('base64'),
      mapping_version: NARRATIVE_IMPORT_MAPPING,
      columns: [...NARRATIVE_IMPORT_COLUMNS],
      causes,
    };
  }

  /** The fields a request asks for: all of them when it names none; a name that is not a field is 422. */
  private fieldsOf(named: readonly string[] | undefined): NarrativeField[] {
    if (named === undefined || named.length === 0) return [...NARRATIVE_FIELDS];
    named.forEach((field, index) => {
      if (!isNarrativeField(field) || named.indexOf(field) !== index) throw new DomainError('VALIDATION_FAILED', 422, `fields[${index}]`);
    });
    return named as NarrativeField[];
  }
}
