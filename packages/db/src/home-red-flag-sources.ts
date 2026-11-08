import { GOV10_SCREENS, message } from '@machvon/kernel';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { SOURCE_LIMIT, base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the auditors who read red flags (on the whole tenant: a red flag belongs to no unit). */
export const RED_FLAG_READ_PERMISSION = 'aud.redflag.read';

/**
 * The red flags that wait for an auditor, as a source of the alert centre (G4-3, ALERT_TYPE `RED_FLAG_NEW`): the findings that are new or being reviewed, to the auditors only. A person who took part in the procurement or
 * the contract a finding is about never gets it (the same fragment as every read of the store), and a reader without the right gets nothing, not even a count. The alert says there is a signal and where to look; it says
 * nothing of why, and it is never a conclusion.
 */
export class HomeRedFlagSources {
  async items(context: SourceContext): Promise<SourceRow[]> {
    if (context.holds?.(RED_FLAG_READ_PERMISSION, true) !== true) return [];
    const rows = await context.tx.query<{ id: string; subject_code: string; band: string; score: number; status: string; first_flagged_at: string }>(
      `select f.id, f.subject_code, f.band, f.score, f.status, to_char(f.first_flagged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_flagged_at
         from machvon.red_flag_finding f
        where f.band <> 'NONE' and f.status in ('NEW', 'IN_REVIEW')
          and not exists (select 1 from machvon.red_flag_involved i where i.tenant_id = f.tenant_id and i.finding_id = f.id and i.membership_id = $1::uuid)
        order by f.score desc, f.first_flagged_at, f.id limit ${SOURCE_LIMIT}`,
      [context.membershipId],
    );
    return rows.map((row) => ({
      ...base('RED_FLAG_NEW'),
      id: row.id,
      dueOn: null,
      originalDueOn: null,
      title: message('home.source.red_flag.title', { code: row.subject_code }),
      subtitle: message(`home.source.red_flag.band_${row.band.toLowerCase()}`, { score: String(row.score) }),
      status: row.status,
      severity: severityOf('RED_FLAG', row.status, context.rules),
      lifecycle: row.status === 'IN_REVIEW' ? 'IN_PROGRESS' : 'NEW',
      consequence: CONSEQUENCES.RED_FLAG_NEW ?? null,
      causeKey: `redflag:${row.id}`,
      startedAt: row.first_flagged_at,
      target: { screen: GOV10_SCREENS.redFlagDetail, id: row.id },
    }));
  }
}
