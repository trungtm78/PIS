// Chapter card: a big number, the chapter title, one sentence and an optional list of what the chapter shows.
import { appear, el, esc, ramp, requireFields, stage } from './kit.mjs';

export const kind = 'chapter';

export function problems(data) {
  return requireFields(data, kind, ['number', 'title', 'durationMs']);
}

export function render(data, t) {
  const items = (data.items ?? []).map((item, index) => el('li', 'chapter-card__item', appear(t, 1100 + index * 220, { dur: 500, rise: 14 }), esc(item))).join('');
  const body =
    el('div', 'chapter-card__number', appear(t, 100, { dur: 700, rise: 24 }), esc(String(data.number).padStart(2, '0'))) +
    el(
      'div',
      'chapter-card__body',
      {},
      el('h1', 'chapter-card__title', appear(t, 350, { dur: 700 }), esc(data.title)) +
        (data.summary === undefined ? '' : el('p', 'chapter-card__summary', appear(t, 700, { dur: 700 }), esc(data.summary))) +
        (items === '' ? '' : el('ul', 'chapter-card__items', { opacity: ramp(t, 1000, 300) }, items)),
    );
  return stage(data, t, el('div', 'chapter-card', {}, body));
}
