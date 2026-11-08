/**
 * The mark of the application icon, drawn once as geometry and rendered two ways (an SVG text and a PNG raster), so that the files always agree.
 * The master shape of the brand (`brand/README.md`): an M made of rising bars. A short and a tall pillar stand on one base line, a chevron between
 * them forms the valley of the M, and a gold base line runs under the three (the foundation the capital stands on). The colours are tokens of the design
 * (or the palette of an edition), given by the caller, never written here.
 * The canvas is 512 units; a maskable icon fills it edge to edge and keeps the mark inside the central circle of 80% that the platforms never cut.
 */

export interface IconColors {
  /** The background: `color.sidebar`. */
  background: string;
  /** The first, shorter pillar: `color.menuMuted`. */
  barLow: string;
  /** The chevron of the M: `color.selectedBar`. */
  barMid: string;
  /** The tallest pillar: `color.menuText`. */
  barHigh: string;
  /** The base line under the mark: `color.fundCarryOver` (the gold). */
  accent: string;
}

export type Point = readonly [number, number];

export interface Shape {
  /** The bounding box; for a rounded rectangle it is the shape itself. */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** Present for a polygon. */
  points?: readonly Point[];
  fill: keyof IconColors;
}

export const CANVAS = 512;
const CORNER = 112;

/** The polygon of a thick polyline with mitred corners: the left side forward, then the right side back. */
export function strokePolyline(path: readonly Point[], halfWidth: number): Point[] {
  const normals: Point[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const [x0, y0] = path[i] as Point;
    const [x1, y1] = path[i + 1] as Point;
    const length = Math.hypot(x1 - x0, y1 - y0);
    normals.push([-(y1 - y0) / length, (x1 - x0) / length]);
  }
  const side = (sign: number): Point[] =>
    path.map((point, i) => {
      const a = (normals[i - 1] ?? normals[i]) as Point;
      const b = (normals[i] ?? normals[i - 1]) as Point;
      // The mitre offset of a corner between two edges with unit normals a and b is h (a + b) / (1 + a.b).
      const k = halfWidth / (1 + a[0] * b[0] + a[1] * b[1]);
      return [point[0] + sign * (a[0] + b[0]) * k, point[1] + sign * (a[1] + b[1]) * k] as Point;
    });
  return [...side(1), ...side(-1).reverse()];
}

function rect(x: number, y: number, width: number, height: number, radius: number, fill: keyof IconColors): Shape {
  return { x, y, width, height, radius, fill };
}

function polygon(points: readonly Point[], fill: keyof IconColors): Shape {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, radius: 0, points, fill };
}

/**
 * The mark: drawn over the background, in this order (the chevron first, so the pillars cover its ends).
 * Every point is within 205 units of the centre (the safe circle of a maskable icon).
 */
export const MARK: readonly Shape[] = [
  polygon(strokePolyline([[138, 204], [256, 304], [374, 172]], 27), 'barMid'),
  rect(106, 176, 64, 176, 16, 'barLow'),
  rect(342, 126, 64, 226, 16, 'barHigh'),
  rect(106, 370, 300, 14, 7, 'accent'),
];

function cornersOf(shape: Shape): readonly Point[] {
  return shape.points ?? [[shape.x, shape.y], [shape.x + shape.width, shape.y], [shape.x, shape.y + shape.height], [shape.x + shape.width, shape.y + shape.height]];
}

/** The farthest any point of the mark is from the centre of the canvas. */
export function markReach(): number {
  const centre = CANVAS / 2;
  let reach = 0;
  for (const shape of MARK) for (const [x, y] of cornersOf(shape)) reach = Math.max(reach, Math.hypot(x - centre, y - centre));
  return reach;
}

/** The background shape: rounded for an icon that stands alone, square for a maskable one (the platform cuts the shape). */
function background(maskable: boolean): Shape {
  return { x: 0, y: 0, width: CANVAS, height: CANVAS, radius: maskable ? 0 : CORNER, fill: 'background' };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** The shapes of the mark as SVG elements, filled with the given colours. */
export function markElements(colors: IconColors): string {
  return MARK.map((shape) =>
    shape.points === undefined
      ? `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.radius}" fill="${colors[shape.fill]}"/>`
      : `<polygon points="${shape.points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')}" fill="${colors[shape.fill]}"/>`,
  ).join('');
}

/** The icon as SVG text. */
export function iconSvg(colors: IconColors, options: { maskable?: boolean } = {}): string {
  const base = background(options.maskable === true);
  const back = `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${base.radius}" fill="${colors.background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}" role="img">${back}${markElements(colors)}</svg>\n`;
}

function insidePolygon(points: readonly Point[], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i] as Point;
    const [xj, yj] = points[j] as Point;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideShape(shape: Shape, px: number, py: number): boolean {
  if (shape.points !== undefined) return insidePolygon(shape.points, px, py);
  if (px < shape.x || px > shape.x + shape.width || py < shape.y || py > shape.y + shape.height) return false;
  const r = shape.radius;
  if (r === 0) return true;
  const cx = px < shape.x + r ? shape.x + r : px > shape.x + shape.width - r ? shape.x + shape.width - r : px;
  const cy = py < shape.y + r ? shape.y + r : py > shape.y + shape.height - r ? shape.y + shape.height - r : py;
  return Math.hypot(px - cx, py - cy) <= r;
}

function rgbOf(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

const SAMPLES = 4;

/** The icon as RGBA bytes at a size, each pixel the average of 4 x 4 samples, so the edges are smooth. */
export function iconRgba(colors: IconColors, size: number, options: { maskable?: boolean } = {}): Uint8Array {
  const shapes = [background(options.maskable === true), ...MARK];
  const out = new Uint8Array(size * size * 4);
  const scale = CANVAS / size;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (column + (sx + 0.5) / SAMPLES) * scale;
          const py = (row + (sy + 0.5) / SAMPLES) * scale;
          let hit: Shape | undefined;
          for (const shape of shapes) if (insideShape(shape, px, py)) hit = shape;
          if (hit === undefined) continue;
          const [r, g, b] = rgbOf(colors[hit.fill]);
          red += r;
          green += g;
          blue += b;
          alpha += 1;
        }
      }
      const at = (row * size + column) * 4;
      const covered = alpha === 0 ? 1 : alpha;
      out[at] = Math.round(red / covered);
      out[at + 1] = Math.round(green / covered);
      out[at + 2] = Math.round(blue / covered);
      out[at + 3] = Math.round((alpha / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return out;
}
