import { message } from '@machvon/kernel';
import { CONSEQUENCES, forAudience, severityOf, workSourceBase } from '@machvon/db';
import type { ConnectorAlertReader, WorkSourceContext, WorkSourceRow } from '@machvon/db';
import { textsOf } from '../report-forms/texts.ts';
import { EBS_CONNECTION, EntConnectionStore, HPM_CONNECTION } from './ent-connection-store.ts';
import { EbsConnectionReads } from './ebs-store.ts';
import { HPM_CONNECTOR_CODE } from './hpm-rules.ts';
import { EBS_CONNECTOR_CODE } from './ebs-rules.ts';
import { HpmPushStore } from './hpm-store.ts';

/** The permissions whose holders are the audience of the alerts of the connections: the administrator of each connection, on the whole tenant (the connections belong to no unit). */
export const HPM_AUDIENCE_PERMISSION = 'hpm.admin';
export const EBS_AUDIENCE_PERMISSION = 'ebs.admin';

interface RowTexts {
  rows: { hpmPushFailedTitle: string; hpmPushFailedDetail: string; hpmPushStaleTitle: string; hpmPushStaleDetail: string };
}

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{([a-z]+)\}/g, (_place, name: string) => String(values[name] ?? ''));

/**
 * The push log of HPM in the alert centre (ENT-2): a failed push that nobody retried (`HPM_PUSH_FAILED`) or a last delivery older than the rule allows (`HPM_PUSH_STALE`), at the severity of `HPM_PUSH_POLICY`, for the administrator of the
 * connection. A tenant that never pushed is not nagged and one that switched the connection off with a reason is not either. The age is computed when the list is read, so there is no job to run and nothing to fall behind.
 */
export const hpmAlertReader: ConnectorAlertReader = {
  id: HPM_CONNECTOR_CODE,
  async read(context: WorkSourceContext): Promise<WorkSourceRow[]> {
    const connection = await new EntConnectionStore(HPM_CONNECTION).current(context.tx);
    if (connection.id === null || !connection.enabled) return [];
    const reading = await new HpmPushStore().health(context.tx, context.now, true);
    const alert = reading.health.alert;
    if (alert === null) return [];
    const texts = textsOf<RowTexts>('integration').rows;
    const failed = alert.code === 'HPM_PUSH_FAILED';
    const startedAt = failed ? (reading.lastFailedAt ?? context.now.toISOString()) : new Date(Date.parse(reading.lastDeliveryAt ?? context.now.toISOString()) + reading.rule.params.max_age_hours * 3_600_000).toISOString();
    const row: WorkSourceRow = {
      ...workSourceBase('CONNECTOR_STALE'),
      id: `${HPM_CONNECTOR_CODE}:${alert.code.toLowerCase()}`,
      dueOn: context.today,
      originalDueOn: startedAt.slice(0, 10),
      title: failed ? texts.hpmPushFailedTitle : texts.hpmPushStaleTitle,
      subtitle: failed ? fill(texts.hpmPushFailedDetail, { count: reading.health.failedPushes }) : fill(texts.hpmPushStaleDetail, { hours: Math.round(reading.health.ageHours ?? 0), max: reading.rule.params.max_age_hours }),
      status: failed ? 'FAILED' : 'STALE',
      severity: severityOf('CONNECTOR', `STALE_${alert.severity}`, context.rules),
      lifecycle: 'NEW',
      consequence: null,
      causeKey: `connector:${HPM_CONNECTOR_CODE}`,
      startedAt,
      target: { screen: 'HPM-01', id: connection.id },
      alertTypeCode: alert.code,
    };
    return forAudience(context, 'CONNECTOR', HPM_AUDIENCE_PERMISSION, [row], true);
  },
};

/** The file import of Oracle EBS in the alert centre: the base alert `CONNECTOR_STALE` when the last applied file is older than the rule of the code `EBS_FILE` allows, for the administrator of the connection. */
export const ebsAlertReader: ConnectorAlertReader = {
  id: EBS_CONNECTOR_CODE,
  async read(context: WorkSourceContext): Promise<WorkSourceRow[]> {
    const connection = await new EntConnectionStore(EBS_CONNECTION).current(context.tx);
    if (connection.id === null || !connection.enabled) return [];
    const reading = await new EbsConnectionReads().health(context.tx, context.now, connection.layoutVersion);
    const alert = reading.health.alert;
    if (alert === null || reading.lastImportAt === null) return [];
    const staleSince = new Date(Date.parse(reading.lastImportAt) + reading.rule.params.max_age_hours * 3_600_000).toISOString();
    const age = reading.health.ageHours;
    const row: WorkSourceRow = {
      ...workSourceBase('CONNECTOR_STALE'),
      id: `${EBS_CONNECTOR_CODE}:stale`,
      dueOn: context.today,
      originalDueOn: staleSince.slice(0, 10),
      title: message('home.source.connector.title', { code: EBS_CONNECTOR_CODE }),
      subtitle: age === null ? null : message('home.source.connector.detail', { hours: Math.round(age), max: String(reading.rule.params.max_age_hours) }),
      status: 'STALE',
      severity: severityOf('CONNECTOR', `STALE_${alert.severity}`, context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES.CONNECTOR_STALE ?? null,
      causeKey: `connector:${EBS_CONNECTOR_CODE}`,
      startedAt: staleSince,
      target: { screen: 'EBS-01', id: connection.id },
    };
    return forAudience(context, 'CONNECTOR', EBS_AUDIENCE_PERMISSION, [row], true);
  },
};
