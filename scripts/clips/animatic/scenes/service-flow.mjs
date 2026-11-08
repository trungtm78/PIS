import { requireFields } from './kit.mjs';
import { renderFlow, topologyProblems } from './topology.mjs';

export const kind = 'service-flow';

export function problems(data) {
  return [...requireFields(data, kind, ['title', 'durationMs', 'nodes', 'links', 'steps']), ...(data.nodes === undefined || data.links === undefined ? [] : topologyProblems(data))];
}

export const render = renderFlow;
