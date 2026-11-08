// The alert severity ladder: three rungs (Urgent, Action, Watch) with an example and its consequence, the life cycle of an alert,
// the two clocks and the escalation chain. Source of the words and the rules: design.md, section "Alert centre".
import { GLYPH, appear, el, esc, heading, icon, num, pill, ramp, requireFields, stage } from './kit.mjs';

export const kind = 'alert-ladder';

const GLYPH_OF_TONE = { danger: GLYPH.late, warning: GLYPH.attention, neutral: GLYPH.hold };
const RUNG = { x: 60, y: 180, w: 1100, h: 215, gap: 28, indent: 56 };

export function problems(data) {
  const found = requireFields(data, kind, ['title', 'durationMs', 'rungs', 'lifecycle', 'clocks', 'escalation', 'labels']);
  if (found.length > 0) return found;
  if (data.rungs.length !== 3) found.push('alert-ladder: there are three rungs');
  for (const rung of data.rungs) if (!Object.hasOwn(GLYPH_OF_TONE, rung.tone)) found.push(`alert-ladder: rung ${rung.severity} has the unknown tone ${rung.tone}`);
  return found;
}

function rungHtml(rung, index, t, data) {
  // The order of the data is the order of the ladder from the top; the rungs appear from the bottom up.
  const order = data.rungs.length - 1 - index;
  const at = 700 + order * 1100;
  const y = RUNG.y + index * (RUNG.h + RUNG.gap);
  const x = RUNG.x + (data.rungs.length - 1 - index) * RUNG.indent;
  const body =
    el('div', 'al-rung__head', {}, pill(rung.tone, rung.label, GLYPH_OF_TONE[rung.tone]) + el('span', 'al-rung__rule', {}, esc(rung.rule))) +
    el('div', 'al-rung__alert', {}, el('b', '', {}, esc(rung.example.title)) + el('span', '', {}, `${icon('clock', 24)} ${esc(rung.example.due)}`)) +
    el('div', 'al-rung__consequence', {}, `${el('em', '', {}, esc(data.labels.consequence))} ${esc(rung.consequence)}`);
  return el(
    'div',
    `al-rung al-rung--${rung.tone}`,
    { left: `${x}px`, top: `${y}px`, width: `${RUNG.w - (data.rungs.length - 1) * RUNG.indent}px`, height: `${RUNG.h}px`, ...appear(t, at, { dur: 600, rise: 28 }) },
    body,
  );
}

export function render(data, t) {
  const rungs = data.rungs.map((rung, index) => rungHtml(rung, index, t, data)).join('');
  const lifeStart = 4600;
  const current = Math.min(data.lifecycle.length - 1, Math.max(0, Math.floor((t - lifeStart - 800) / 1100)));
  const chips = data.lifecycle
    .map((item, index) => {
      const reached = t >= lifeStart + 800 + index * 1100;
      const active = reached && index === current;
      const chip = el(
        'div',
        `al-chip${active ? ' is-active' : ''}${reached ? ' is-reached' : ''}`,
        appear(t, lifeStart + 300 + index * 180, { dur: 450, rise: 10 }),
        el('b', '', {}, esc(item.label)) + el('span', '', {}, esc(item.note)),
      );
      return index === 0 ? chip : el('div', 'al-arrow', { opacity: ramp(t, lifeStart + 300 + index * 180, 400) }, '↓') + chip;
    })
    .join('');
  const life = el('section', 'al-card al-life', appear(t, lifeStart, { dur: 600 }), el('h2', '', {}, esc(data.labels.lifecycle)) + chips);

  const clockStart = 9200;
  const clocks = data.clocks
    .map((clock, index) =>
      el(
        'div',
        'al-clock',
        appear(t, clockStart + index * 300, { dur: 500, rise: 10 }),
        el('div', 'al-clock__row', {}, el('span', '', {}, esc(clock.label)) + el('b', '', {}, esc(clock.value))) +
          el('div', 'al-clock__bar', {}, el('i', '', { width: `${num(clock.fraction * 100 * ramp(t, clockStart + 400 + index * 300, 1200))}%` })),
      ),
    )
    .join('');
  const chain = data.escalation.chain
    .map((step, index) => {
      const shown = clockStart + 1500 + index * 500;
      const node = el('div', 'al-level', appear(t, shown, { dur: 450, rise: 10 }), el('span', 'al-level__dot', {}, icon('user', 26)) + el('b', '', {}, esc(step.level)) + el('span', '', {}, esc(step.who)));
      return index === 0 ? node : el('div', 'al-level__link', { opacity: ramp(t, shown, 350) }, GLYPH.arrow) + node;
    })
    .join('');
  const side = el(
    'section',
    'al-card al-clocks',
    appear(t, clockStart, { dur: 600 }),
    el('h2', '', {}, esc(data.labels.clocks)) + clocks + el('h2', 'al-escalation-title', {}, esc(data.escalation.title)) + el('div', 'al-chain', {}, chain),
  );
  return stage(data, t, heading(data, t) + rungs + life + side);
}
