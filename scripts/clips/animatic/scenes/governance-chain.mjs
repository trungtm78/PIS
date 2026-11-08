// The governance chain: maker, checker, approver. A document travels from role to role and is stamped at each; the system refuses
// the same person on two roles; everything lands in the audit log.
import { GLYPH, appear, easeInOut, el, esc, heading, icon, num, pill, ramp, requireFields, stage } from './kit.mjs';

export const kind = 'governance-chain';

const CARD = { x: 100, y: 330, w: 480, h: 360, pitch: 620 };

export function problems(data) {
  const found = requireFields(data, kind, ['title', 'durationMs', 'roles', 'document', 'rules', 'refusal', 'audit', 'labels']);
  if (found.length > 0) return found;
  if (data.roles.length !== 3) found.push('governance-chain: there are three roles');
  const last = (data.startMs ?? 1200) + data.roles.length * (data.stepMs ?? 2800);
  if (last + 4000 > data.durationMs) found.push('governance-chain: the scene ends before the refusal and the audit line are shown');
  return found;
}

export function render(data, t) {
  const start = data.startMs ?? 1200;
  const step = data.stepMs ?? 2800;
  const cards = data.roles
    .map((role, index) => {
      const at = 300 + index * 350;
      const arrivedAt = start + index * step;
      const active = t >= arrivedAt && (index === data.roles.length - 1 || t < arrivedAt + step);
      const x = CARD.x + index * CARD.pitch;
      const stampU = ramp(t, arrivedAt + 900, 350);
      const stamp = el('div', 'gv-stamp', { opacity: stampU, transform: `rotate(-6deg) scale(${num(1.4 - 0.4 * stampU)})` }, `${GLYPH.ok} ${esc(role.stamp)}`);
      const card = el(
        'div',
        `gv-card${active ? ' is-active' : ''}`,
        { left: `${x}px`, top: `${CARD.y}px`, width: `${CARD.w}px`, height: `${CARD.h}px`, ...appear(t, at, { dur: 600, rise: 24 }) },
        el('span', 'gv-card__icon', {}, icon(role.icon ?? 'user', 56)) + el('h2', '', {}, esc(role.title)) + el('div', 'gv-card__who', {}, esc(role.who)) + el('p', '', {}, esc(role.action)) + stamp,
      );
      const link = index === 0 ? '' : el('div', 'gv-link', { left: `${x - 120}px`, top: `${CARD.y + CARD.h / 2 - 24}px`, opacity: ramp(t, at, 400) }, GLYPH.arrow);
      return card + link;
    })
    .join('');

  // The document sits above the first card, then slides to each role in turn.
  const centreOf = (index) => CARD.x + index * CARD.pitch + CARD.w / 2;
  let docX = centreOf(0);
  for (let index = 1; index < data.roles.length; index += 1) {
    docX += (centreOf(index) - centreOf(index - 1)) * ramp(t, start + index * step - 700, 700, easeInOut);
  }
  const doc = el(
    'div',
    'gv-doc',
    { left: `${num(docX - 190)}px`, top: '195px', ...appear(t, 800, { dur: 500 }) },
    el('span', '', {}, icon('file', 34)) + el('b', '', {}, esc(data.document.title)) + el('i', '', {}, esc(data.document.code)),
  );

  const rulesAt = start + data.roles.length * step - 200;
  const rules = data.rules.map((rule, index) => el('li', '', appear(t, rulesAt + index * 450, { dur: 450, rise: 10 }), `${el('span', '', {}, GLYPH.ok)} ${esc(rule)}`)).join('');
  const refusalAt = rulesAt + data.rules.length * 450 + 700;
  const refusal = el('div', 'gv-refusal', appear(t, refusalAt, { dur: 500 }), pill('danger', data.labels.refused, GLYPH.late) + el('span', '', {}, esc(data.refusal)));
  const audit = el('div', 'gv-audit', appear(t, refusalAt + 1400, { dur: 500 }), `${icon('stamp', 30)} ${esc(data.audit)}`);
  const lower = el('div', 'gv-lower', { top: '730px' }, el('ul', 'gv-rules', {}, rules) + el('div', 'gv-side', {}, refusal + audit));
  return stage(data, t, heading(data, t) + cards + doc + lower);
}
