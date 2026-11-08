import { requireFields } from './kit.mjs';
import { renderPlatform, topologyProblems } from './topology.mjs';

export const kind = 'platform';

export function problems(data) {
  return [...requireFields(data, kind, ['title', 'durationMs', 'nodes', 'links']), ...(data.nodes === undefined || data.links === undefined ? [] : topologyProblems(data))];
}

export const render = renderPlatform;
