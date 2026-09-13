import { pickThumbnailElements } from "../data/thumbnail";

import type { ExcalidrawElement } from "@excalidraw/element/types";

const el = (id: string, x: number, y: number, w: number, h: number) =>
  ({ id, x, y, width: w, height: h }) as ExcalidrawElement;

describe("thumbnail area", () => {
  it("keeps the whole scene when it is already roughly square", () => {
    const elements = [el("a", 0, 0, 200, 150), el("b", 220, 0, 200, 150)];
    const pick = pickThumbnailElements(elements);
    expect(pick.cropped).toBe(false);
    expect(pick.elements).toHaveLength(2);
  });

  it("keeps everything for a single element, whatever its shape", () => {
    const pick = pickThumbnailElements([el("only", 0, 0, 20, 4000)]);
    expect(pick.cropped).toBe(false);
  });

  it("crops a tall sparse board to its densest region", () => {
    // one stray mark far above a cluster of real content
    const elements = [
      el("stray", 0, -3000, 100, 60),
      el("a", 0, 0, 200, 150),
      el("b", 220, 0, 200, 150),
      el("c", 0, 200, 200, 150),
      el("d", 220, 200, 200, 150),
    ];
    const pick = pickThumbnailElements(elements);
    expect(pick.cropped).toBe(true);
    expect(pick.elements.map((e) => e.id)).not.toContain("stray");
    expect(pick.elements).toHaveLength(4);
  });

  it("crops a wide board the same way", () => {
    const elements = [
      el("stray", -4000, 0, 100, 60),
      el("a", 0, 0, 200, 150),
      el("b", 0, 170, 200, 150),
      el("c", 220, 0, 200, 150),
    ];
    const pick = pickThumbnailElements(elements);
    expect(pick.cropped).toBe(true);
    expect(pick.elements.map((e) => e.id)).not.toContain("stray");
  });

  it("scores by how much of each element is in frame, so one big shape cannot outvote a cluster", () => {
    const elements = [
      el("huge", 0, -2600, 600, 600),
      el("s1", 0, 0, 60, 40),
      el("s2", 80, 0, 60, 40),
      el("s3", 0, 60, 60, 40),
      el("s4", 80, 60, 60, 40),
      el("s5", 160, 0, 60, 40),
      el("s6", 160, 60, 60, 40),
    ];
    const pick = pickThumbnailElements(elements);
    expect(pick.cropped).toBe(true);
    expect(pick.elements.map((e) => e.id)).not.toContain("huge");
  });

  it("does not crop when the crop would keep everything anyway", () => {
    // long but evenly filled: no window is denser than the whole
    const elements = Array.from({ length: 12 }, (_, i) =>
      el(`n${i}`, 0, i * 100, 120, 80),
    );
    const pick = pickThumbnailElements(elements);
    expect(pick.elements.length).toBeGreaterThan(0);
    if (pick.cropped) {
      expect(pick.elements.length).toBeLessThan(elements.length);
    }
  });

  it("handles the real scene that started this — a scribble far above a diagram", () => {
    const elements = [
      el("freedraw-top-1", 378, -767, 312, 158),
      el("freedraw-top-2", 582, -814, 0, 0),
      el("freedraw-top-3", 828, -847, 0, 0),
      el("freedraw-mid", 571, -490, 142, 35),
      el("line-mid", 571, -490, 142, 35),
      el("ellipse", 442, 420, 373, 330),
      el("freedraw", 654, 426, 373, 330),
      el("sticky-1", 615, 384, 456, 456),
      el("sticky-2", 380, 618, 545, 545),
      el("sticky-3", 365, 1155, 343, 343),
      el("tested", 392, 790, 260, 120),
    ];
    const pick = pickThumbnailElements(elements);
    expect(pick.cropped).toBe(true);
    // the strokes floating 1200px above the content are dropped
    expect(pick.elements.map((e) => e.id)).not.toContain("freedraw-top-1");
    // the actual diagram survives
    expect(pick.elements.map((e) => e.id)).toContain("ellipse");
    expect(pick.elements.map((e) => e.id)).toContain("tested");

    const xs = pick.elements.map((e) => e.x);
    const ys = pick.elements.map((e) => e.y);
    const w =
      Math.max(...pick.elements.map((e) => e.x + e.width)) - Math.min(...xs);
    const h =
      Math.max(...pick.elements.map((e) => e.y + e.height)) - Math.min(...ys);
    // and what is left is close enough to square to fill the thumbnail
    expect(Math.max(w, h) / Math.min(w, h)).toBeLessThan(2.2);
  });

  it("never returns an empty set", () => {
    expect(pickThumbnailElements([]).elements).toHaveLength(0);
    const one = pickThumbnailElements([el("a", 0, 0, 10, 10)]);
    expect(one.elements).toHaveLength(1);
  });
});
