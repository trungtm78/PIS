import type { TenantName } from '../../suite';
import { directiveMarkers } from './directive.fixtures';
import { egpMarkers } from './egp.fixtures';
import { govruleMarkers } from './govrule.fixtures';
import { homeMarkers } from './home.fixtures';
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
    ...govruleMarkers(tenant),
    ...homeMarkers(tenant),
    ...payctlMarkers(tenant),
    ...ratingMarkers(tenant),
    ...reserveMarkers(tenant),
    ...workflowMarkers(tenant),
  ];
}
