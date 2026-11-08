// Text to SVG outlines, so that a lockup needs no font at runtime: a small reader of TrueType files (cmap format 4 and 12, glyf with
// composites, hmtx). It reads the Be Vietnam Pro files that the phone app bundles (OFL, see apps/web/public/fonts/OFL.txt).
import { readFileSync } from 'node:fs';

export function loadFont(path) {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = {};
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
    tables[tag] = { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) };
  }
  const head = tables.head.offset;
  const unitsPerEm = view.getUint16(head + 18);
  const longLoca = view.getInt16(head + 50) === 1;
  const glyphCount = view.getUint16(tables.maxp.offset + 4);
  const metricCount = view.getUint16(tables.hhea.offset + 34);

  const locaAt = (index) => (longLoca ? view.getUint32(tables.loca.offset + index * 4) : view.getUint16(tables.loca.offset + index * 2) * 2);
  const advanceOf = (glyph) => view.getUint16(tables.hmtx.offset + Math.min(glyph, metricCount - 1) * 4);

  // cmap: prefer a format 12 (full Unicode) subtable, else a format 4 one for the Basic Multilingual Plane.
  const cmapAt = tables.cmap.offset;
  const subtables = [];
  for (let i = 0; i < view.getUint16(cmapAt + 2); i += 1) {
    const offset = cmapAt + view.getUint32(cmapAt + 4 + i * 8 + 4);
    subtables.push({ offset, format: view.getUint16(offset) });
  }
  const sub12 = subtables.find((s) => s.format === 12);
  const sub4 = subtables.find((s) => s.format === 4);

  function glyphOf(codePoint) {
    if (sub12 !== undefined) {
      const groups = view.getUint32(sub12.offset + 12);
      for (let i = 0; i < groups; i += 1) {
        const g = sub12.offset + 16 + i * 12;
        const start = view.getUint32(g);
        const end = view.getUint32(g + 4);
        if (codePoint >= start && codePoint <= end) return view.getUint32(g + 8) + (codePoint - start);
      }
    }
    if (sub4 !== undefined && codePoint < 0x10000) {
      const o = sub4.offset;
      const segX2 = view.getUint16(o + 6);
      const ends = o + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i += 1) {
        const end = view.getUint16(ends + i * 2);
        if (codePoint > end) continue;
        const start = view.getUint16(starts + i * 2);
        if (codePoint < start) return 0;
        const delta = view.getInt16(deltas + i * 2);
        const rangeOffset = view.getUint16(ranges + i * 2);
        if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
        const g = view.getUint16(ranges + i * 2 + rangeOffset + (codePoint - start) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
    }
    return 0;
  }

  // Contours of a glyph as lists of {x, y, on}, in font units, y up.
  function contoursOf(glyph, depth = 0) {
    if (glyph >= glyphCount || depth > 6) return [];
    const start = locaAt(glyph);
    if (start === locaAt(glyph + 1)) return [];
    const base = tables.glyf.offset + start;
    const n = view.getInt16(base);
    if (n >= 0) {
      const ends = [];
      for (let i = 0; i < n; i += 1) ends.push(view.getUint16(base + 10 + i * 2));
      const total = n === 0 ? 0 : ends[n - 1] + 1;
      let p = base + 10 + n * 2;
      p += 2 + view.getUint16(p);
      const flags = [];
      while (flags.length < total) {
        const f = view.getUint8(p);
        p += 1;
        flags.push(f);
        if (f & 8) {
          let repeat = view.getUint8(p);
          p += 1;
          while (repeat > 0) {
            flags.push(f);
            repeat -= 1;
          }
        }
      }
      const read = (shortBit, sameBit) => {
        const out = [];
        let value = 0;
        for (const f of flags) {
          if (f & shortBit) {
            const d = view.getUint8(p);
            p += 1;
            value += f & sameBit ? d : -d;
          } else if (!(f & sameBit)) {
            value += view.getInt16(p);
            p += 2;
          }
          out.push(value);
        }
        return out;
      };
      const xs = read(2, 16);
      const ys = read(4, 32);
      const contours = [];
      let first = 0;
      for (const end of ends) {
        const contour = [];
        for (let i = first; i <= end; i += 1) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        contours.push(contour);
        first = end + 1;
      }
      return contours;
    }
    // Composite glyph: components with an offset and an optional scale.
    let p = base + 10;
    const out = [];
    for (;;) {
      const f = view.getUint16(p);
      const component = view.getUint16(p + 2);
      p += 4;
      let dx;
      let dy;
      if (f & 1) {
        dx = view.getInt16(p);
        dy = view.getInt16(p + 2);
        p += 4;
      } else {
        dx = view.getInt8(p);
        dy = view.getInt8(p + 1);
        p += 2;
      }
      if (!(f & 2)) {
        dx = 0;
        dy = 0;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = (at) => view.getInt16(at) / 16384;
      if (f & 8) {
        a = d = f2(p);
        p += 2;
      } else if (f & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (f & 0x80) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      for (const contour of contoursOf(component, depth + 1)) out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      if (!(f & 0x20)) break;
    }
    return out;
  }

  return { unitsPerEm, glyphOf, advanceOf, contoursOf };
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/** The SVG path data of one contour of quadratic curves, scaled and placed (x right, baseline at y). */
function contourPath(contour, scale, ox, oy) {
  if (contour.length < 2) return '';
  const px = (pt) => ox + pt.x * scale;
  const py = (pt) => oy - pt.y * scale;
  // Start at an on-curve point; with none, start at the midpoint of the first two off-curve points.
  const s = contour.findIndex((pt) => pt.on);
  const points =
    s === -1
      ? [{ x: (contour[0].x + contour[1].x) / 2, y: (contour[0].y + contour[1].y) / 2, on: true }, ...contour.slice(1), contour[0]]
      : [...contour.slice(s), ...contour.slice(0, s)];
  const start = points[0];
  let d = `M${fmt(px(start))} ${fmt(py(start))}`;
  let pending;
  for (const pt of [...points.slice(1), start]) {
    if (pt.on) {
      d += pending === undefined ? `L${fmt(px(pt))} ${fmt(py(pt))}` : `Q${fmt(px(pending))} ${fmt(py(pending))} ${fmt(px(pt))} ${fmt(py(pt))}`;
      pending = undefined;
    } else {
      if (pending !== undefined) {
        const mid = { x: (pending.x + pt.x) / 2, y: (pending.y + pt.y) / 2 };
        d += `Q${fmt(px(pending))} ${fmt(py(pending))} ${fmt(px(mid))} ${fmt(py(mid))}`;
      }
      pending = pt;
    }
  }
  return `${d}Z`;
}

/**
 * Text as one path: `size` is the font size in the units of the drawing, `tracking` the extra space after each glyph in em.
 * Returns the path data, the width of the run (without the space after the last glyph) and the x at which it starts for the anchor.
 */
export function textPath(font, text, { size, tracking = 0, x = 0, y = 0, anchor = 'start' }) {
  const scale = size / font.unitsPerEm;
  const glyphs = [...text].map((ch) => font.glyphOf(ch.codePointAt(0)));
  const advances = glyphs.map((g) => font.advanceOf(g) * scale + tracking * size);
  const width = advances.reduce((sum, a) => sum + a, 0) - tracking * size;
  const startX = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  let cursor = startX;
  let d = '';
  glyphs.forEach((g, i) => {
    for (const contour of font.contoursOf(g)) d += contourPath(contour, scale, cursor, y);
    cursor += advances[i];
  });
  return { d, width, x: startX };
}
