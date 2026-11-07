/**
 * The mark of the application icon, drawn once as geometry and rendered two ways (an SVG text and a PNG raster), so that the files always agree.
 * Three rising bars over a baseline on the colour of the sidebar: the colours are the tokens of the design, given by the caller, never written here.
 * The canvas is 512 units; a maskable icon fills it edge to edge and keeps the mark inside the central circle of 80% that the platforms never cut.
 */

export interface IconColors {
  /** The background: `color.sidebar`. */
  background: string;
  /** The first, shortest bar: `color.menuMuted`. */
  barLow: string;
  /** The middle bar and the baseline: `color.selectedBar`. */
  barMid: string;
  /** The tallest bar: `color.menuText`. */
  barHigh: string;
}

export interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: keyof IconColors;
}

export const CANVAS = 512;
const CORNER = 112;

/** The mark: drawn over the background, in this order. Every point is within 205 units of the centre (the safe circle of a maskable icon). */
export const MARK: readonly Shape[] = [
  { x: 118, y: 292, width: 72, height: 100, radius: 16, fill: 'barLow' },
  { x: 220, y: 232, width: 72, height: 160, radius: 16, fill: 'barMid' },
  { x: 322, y: 162, width: 72, height: 230, radius: 16, fill: 'barHigh' },
  { x: 140, y: 404, width: 232, height: 8, radius: 4, fill: 'barMid' },
];

/** The farthest any point of the mark is from the centre of the canvas. */
export function markReach(): number {
  const centre = CANVAS / 2;
  let reach = 0;
  for (const shape of MARK) {
    for (const x of [shape.x, shape.x + shape.width]) for (const y of [shape.y, shape.y + shape.height]) reach = Math.max(reach, Math.hypot(x - centre, y - centre));
  }
  return reach;
}

/** The background shape: rounded for an icon that stands alone, square for a maskable one (the platform cuts the shape). */
function background(maskable: boolean): Shape {
  return { x: 0, y: 0, width: CANVAS, height: CANVAS, radius: maskable ? 0 : CORNER, fill: 'background' };
}

/** The icon as SVG text. */
export function iconSvg(colors: IconColors, options: { maskable?: boolean } = {}): string {
  const shapes = [background(options.maskable === true), ...MARK];
  const rects = shapes.map((shape) => `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${shape.radius}" fill="${colors[shape.fill]}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}" role="img">${rects}</svg>\n`;
}

function insideRounded(shape: Shape, px: number, py: number): boolean {
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
          for (const shape of shapes) if (insideRounded(shape, px, py)) hit = shape;
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
