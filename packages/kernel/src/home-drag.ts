/**
 * What drags a ratio down (G3-3, HOME-10): when a figure is a ratio, each part of it (a unit, a project) pulls the whole up or down by how far its own ratio is from the whole's, in proportion to its share of the
 * denominator. In percentage points: `(numerator of the part x denominator of the whole - denominator of the part x numerator of the whole) / denominator of the whole squared`. The parts that add up to the whole
 * add up to zero, so the order "who drags it down most" is exact and checkable, and it is computed from whole dong with no float.
 */
export interface DragPart {
  id: string;
  numerator: string | null;
  denominator: string | null;
}

export interface DragWhole {
  numerator: string | null;
  denominator: string | null;
}

const SCALE = 10_000n;

/** The pull of one part on the whole in points of percent with four places as text (negative pulls down), or null when it cannot be told (a missing figure, a whole of nothing). */
export function dragPoints(part: DragPart, whole: DragWhole): string | null {
  if (part.numerator === null || part.denominator === null || whole.numerator === null || whole.denominator === null) return null;
  const [n, d, wn, wd] = [BigInt(part.numerator), BigInt(part.denominator), BigInt(whole.numerator), BigInt(whole.denominator)];
  if (wd <= 0n) return null;
  const top = (n * wd - d * wn) * 100n * SCALE;
  const scaledValue = top / (wd * wd);
  const negative = scaledValue < 0n;
  const abs = negative ? -scaledValue : scaledValue;
  const text = abs.toString().padStart(5, '0');
  return `${negative ? '-' : ''}${text.slice(0, -4)}.${text.slice(-4)}`;
}

/** The parts in the order of their pull, the one that drags most first; parts whose pull cannot be told come last, in the order they came. */
export function orderByDrag<T extends DragPart>(parts: readonly T[], whole: DragWhole): Array<T & { dragPoints: string | null }> {
  const withDrag = parts.map((part, index) => ({ part, index, drag: dragPoints(part, whole) }));
  const key = (drag: string): bigint => BigInt(drag.replace('.', ''));
  withDrag.sort((left, right) => {
    if (left.drag === null || right.drag === null) return left.drag === right.drag ? left.index - right.index : left.drag === null ? 1 : -1;
    const a = key(left.drag);
    const b = key(right.drag);
    return a === b ? left.index - right.index : a < b ? -1 : 1;
  });
  return withDrag.map(({ part, drag }) => ({ ...part, dragPoints: drag }));
}
