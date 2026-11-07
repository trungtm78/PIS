/* eslint-disable no-console -- a probe that prints what the server answers */
import { SeedContext } from './context.ts';
const ctx = new SeedContext();
ctx.group = 'probe';
for (const p of ['/resources/allocation_line', '/capital-plans', '/appropriations']) {
  const r = await ctx.call('projectManager', 'GET', p);
  console.log(p, r.status, r.text.slice(0, 500));
}
const pr = await ctx.list('projectManager', '/resources/project');
console.log(pr.map((p) => `${p.code}:${p.status}`).join(' '));
