import type { TenantName } from '../../suite';
import { analyticsMarkers } from './analytics.fixtures';
import { assistMarkers } from './assist.fixtures';
import { directiveMarkers } from './directive.fixtures';
import { egpMarkers } from './egp.fixtures';
import { feedMarkers } from './feed.fixtures';
import { gov10Markers } from './gov10.fixtures';
import { gov11aMarkers } from './gov11a.fixtures';
import { govruleMarkers } from './govrule.fixtures';
import { homeMarkers } from './home.fixtures';
import { hubAgentMarkers } from './hub.fixtures';
import { mr1Markers } from './mr1.fixtures';
import { payctlMarkers } from './payctl.fixtures';
import { ratingMarkers } from './rating.fixtures';
import { reserveMarkers } from './reserve.fixtures';
import type { Marker } from './support';
import { workflowMarkers } from './workflow.fixtures';

/** The markers of everything the governance deepening seeds for a tenant: a value of TNT-B in an answer to TNT-A is a leak. */
export function governanceMarkers(tenant: TenantName): Marker[] {
  return [
    ...directiveMarkers(tenant),
    ...egpMarkers(tenant),
    ...gov11aMarkers(tenant),
    ...govruleMarkers(tenant),
    ...homeMarkers(tenant),
    ...mr1Markers(tenant),
    ...payctlMarkers(tenant),
    ...ratingMarkers(tenant),
    ...reserveMarkers(tenant),
    ...workflowMarkers(tenant),
    ...analyticsMarkers(tenant),
    ...assistMarkers(tenant),
    ...feedMarkers(tenant),
    ...gov10Markers(tenant),
    ...hubAgentMarkers(tenant),
  ];
}
