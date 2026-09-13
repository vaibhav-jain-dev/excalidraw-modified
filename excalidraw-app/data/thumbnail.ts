import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * Picking what a thumbnail should show.
 *
 * A drawing is whatever size it grew to; a thumbnail is a fixed square. Export
 * the whole scene and a board that is tall and narrow — a sketch at the top, a
 * diagram far below — renders as a thin strip with most of the square empty,
 * which is what shipped before this.
 *
 * So when a scene is much longer than it is wide (or the reverse), export only
 * its densest region instead. The heuristic is deliberately cheap: element
 * bounding boxes, a sliding window along the long axis, no rendering. It runs
 * on every save, so it has to cost nothing.
 */

/** past this ratio, fitting the whole scene may waste most of the square */
const MAX_ASPECT = 2.2;

/**
 * ...but elongated is not the same as sparse. A long flowchart fills its
 * length and should be shown whole; a sketch stranded 1200px above a diagram
 * leaves the middle empty. Crop only when the long axis is mostly gap.
 */
const MAX_COVERAGE = 0.65;

/** how much bigger than the short side the crop window is */
const WINDOW_SCALE = 1.35;

/** windows tried along the long axis */
const STEPS = 24;

type Box = { x: number; y: number; w: number; h: number };

const boxOf = (element: ExcalidrawElement): Box => ({
  x: element.x,
  y: element.y,
  w: element.width,
  h: element.height,
});

const bounds = (boxes: Box[]): Box | null => {
  if (!boxes.length) {
    return null;
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x1 - x, h: y1 - y };
};

const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** how much of the long axis any element actually sits on, 0..1 */
const coverage = (boxes: Box[], vertical: boolean, long: number): number => {
  if (long <= 0) {
    return 1;
  }
  const spans = boxes
    .map((b) =>
      vertical
        ? ([b.y, b.y + Math.max(b.h, 1)] as const)
        : ([b.x, b.x + Math.max(b.w, 1)] as const),
    )
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let start = spans[0]![0];
  let end = spans[0]![1];
  for (const [from, to] of spans.slice(1)) {
    if (from > end) {
      covered += end - start;
      start = from;
      end = to;
    } else if (to > end) {
      end = to;
    }
  }
  covered += end - start;
  return covered / long;
};

export interface ThumbnailPick<T> {
  elements: readonly T[];
  /** true when this is a crop, not the whole scene */
  cropped: boolean;
}

export const pickThumbnailElements = <T extends ExcalidrawElement>(
  elements: readonly T[],
): ThumbnailPick<T> => {
  if (elements.length < 2) {
    return { elements, cropped: false };
  }

  const boxes = elements.map(boxOf);
  const all = bounds(boxes);
  if (!all || all.w <= 0 || all.h <= 0) {
    return { elements, cropped: false };
  }

  const long = Math.max(all.w, all.h);
  const short = Math.min(all.w, all.h);
  if (long / short <= MAX_ASPECT) {
    return { elements, cropped: false };
  }

  const vertical = all.h > all.w;
  if (coverage(boxes, vertical, long) > MAX_COVERAGE) {
    return { elements, cropped: false };
  }

  const side = short * WINDOW_SCALE;
  const travel = long - side;
  if (travel <= 0) {
    return { elements, cropped: false };
  }

  let best: { window: Box; score: number } | null = null;
  for (let step = 0; step <= STEPS; step += 1) {
    const offset = (travel * step) / STEPS;
    const window: Box = vertical
      ? { x: all.x, y: all.y + offset, w: all.w, h: side }
      : { x: all.x + offset, y: all.y, w: side, h: all.h };

    let score = 0;
    for (const box of boxes) {
      const covered = overlapArea(window, box);
      if (covered <= 0) {
        continue;
      }
      const area = Math.max(1, box.w * box.h);
      // one element counts once at most, in proportion to how much of it is in
      // frame — so a single huge shape cannot outvote a cluster of small ones
      score += covered / area;
    }
    if (!best || score > best.score) {
      best = { window, score };
    }
  }

  if (!best) {
    return { elements, cropped: false };
  }

  const kept = elements.filter((_, i) => intersects(best!.window, boxes[i]!));
  // a crop that keeps everything, or almost nothing, is not worth making
  if (kept.length === elements.length || kept.length === 0) {
    return { elements, cropped: false };
  }
  return { elements: kept, cropped: true };
};
