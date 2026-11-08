import { defineModule } from '../module-descriptor';
import { CommitteeController } from './committee.controller';
import { CommitteeReadsController } from './committee-reads.controller';

/**
 * BAN, the workspace of the steering committee of the province (lane BAN-1, docs/committee-workspace.md): the committee dashboard (progress by sector, district, investor and funding source against the plan, last year and
 * the curve of the year, with the band of the year end), the projects that need the head ranked by impact, the meeting pack through the report engine, the tracker of overdue directives, the four alerts of the
 * committee, the roster of the committee and the audit of every view of a sensitive screen. It owns the tables `committee`, `committee_member`, `committee_view_audit`, `committee_attention_decision` and
 * `committee_alert`, reads the whole tenant through the port `ProvinceFactsReader` and writes no financial table.
 */
export const banModule = defineModule({
  code: 'BAN',
  controllers: [CommitteeController, CommitteeReadsController],
});

export { CommitteePackProvider, COMMITTEE_PACK_PROVIDER, registerCommitteeReportForm } from './pack-provider';
export { COMMITTEE_ASSURANCE, COMMITTEE_CLOCK, COMMITTEE_FACTS_READER } from './tokens';
export { CommitteeWorkspaceService } from './committee-service';
