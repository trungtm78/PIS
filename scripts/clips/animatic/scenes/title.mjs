// Title card: the name of the product (or the clip), a line that draws itself, a subtitle and a footer.
import { appear, el, esc, num, ramp, requireFields, stage } from './kit.mjs';

export const kind = 'title';

export function problems(data) {
  return requireFields(data, kind, ['title', 'durationMs']);
}

export function render(data, t) {
  const line = ramp(t, 300, 900);
  const kicker = data.kicker === undefined ? '' : el('div', 'title-card__kicker', appear(t, 150, { dur: 600 }), esc(data.kicker));
  const subtitle = data.subtitle === undefined ? '' : el('div', 'title-card__subtitle', appear(t, 900, { dur: 700 }), esc(data.subtitle));
  const footer = data.footer === undefined ? '' : el('div', 'title-card__footer', appear(t, 1300, { dur: 700, rise: 8 }), esc(data.footer));
  const body =
    kicker +
    el('h1', 'title-card__title', appear(t, 450, { dur: 800, rise: 30 }), esc(data.title)) +
    el('div', 'title-card__rule', { width: `${num(line * 220)}px` }) +
    subtitle;
  return stage(data, t, el('div', 'title-card', {}, body) + footer);
}
