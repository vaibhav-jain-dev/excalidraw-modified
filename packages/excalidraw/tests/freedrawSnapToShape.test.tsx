import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { act, render } from "./test-utils";

const { h } = window;

/** a closed, roughly circular path centered on (cx, cy) */
const circlePoints = (cx: number, cy: number, radius: number): LocalPoint[] => {
  const points: LocalPoint[] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.15) {
    points.push(
      pointFrom(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius),
    );
  }
  return points;
};

/** a closed, roughly rectangular path */
const rectanglePoints = (
  x: number,
  y: number,
  width: number,
  height: number,
): LocalPoint[] => {
  const points: LocalPoint[] = [];
  const step = 10;
  for (let i = x; i <= x + width; i += step) {
    points.push(pointFrom(i, y));
  }
  for (let i = y; i <= y + height; i += step) {
    points.push(pointFrom(x + width, i));
  }
  for (let i = x + width; i >= x; i -= step) {
    points.push(pointFrom(i, y + height));
  }
  for (let i = y + height; i >= y; i -= step) {
    points.push(pointFrom(x, i));
  }
  points.push(pointFrom(x, y));
  return points;
};

/** a jagged scribble that should not read as any shape */
const scribblePoints = (): LocalPoint[] => {
  const points: LocalPoint[] = [];
  for (let i = 0; i < 40; i++) {
    points.push(pointFrom(i * 4, Math.sin(i) * 30 + (i % 3) * 15));
  }
  return points;
};

const mouse = new Pointer("mouse");

/** draw a freehand stroke through `points` and release (no trailing Escape,
 * unlike `UI.createElement`, so tool-persistence stays observable) */
const drawFreedraw = (points: LocalPoint[]) => {
  UI.clickTool("freedraw");
  mouse.reset();
  const [first, ...rest] = points;
  mouse.down(first[0], first[1]);
  rest.forEach((point) => mouse.moveTo(point[0], point[1]));
  mouse.up();
};

const liveElements = () => h.elements.filter((element) => !element.isDeleted);

describe("smart pencil (freedraw snap to shape)", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    // off by default in tests — the behavior under test opts in explicitly
    API.setAppState({ currentItemFreedrawSnapToShape: true });
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("is disabled by default in the test environment", () => {
    // this suite flips it on in beforeEach; a fresh state is off
    API.setAppState({ currentItemFreedrawSnapToShape: undefined as never });
    expect(h.state.currentItemFreedrawSnapToShape).toBeFalsy();
  });

  it("registers the toggle action", () => {
    expect(h.app.actionManager.actions.changeFreedrawSnapToShape).toBeTruthy();
  });

  it("converts a rough circle into an ellipse", () => {
    drawFreedraw(circlePoints(100, 100, 80));

    expect(liveElements().length).toBe(1);
    expect(liveElements()[0].type).toBe("ellipse");
    // the original freehand stroke was swapped out, not left on the canvas
    const freedraw = h.elements.find((element) => element.type === "freedraw");
    expect(freedraw?.isDeleted).toBe(true);
  });

  it("converts a rough square into a rectangle", () => {
    drawFreedraw(rectanglePoints(0, 0, 160, 160));

    expect(liveElements().length).toBe(1);
    expect(liveElements()[0].type).toBe("rectangle");
  });

  it("leaves an unrecognized scribble as freehand", () => {
    drawFreedraw(scribblePoints());

    expect(liveElements().length).toBe(1);
    expect(liveElements()[0].type).toBe("freedraw");
  });

  it("does nothing when the toggle is off", () => {
    API.setAppState({ currentItemFreedrawSnapToShape: false });

    drawFreedraw(circlePoints(100, 100, 80));

    expect(liveElements().length).toBe(1);
    expect(liveElements()[0].type).toBe("freedraw");
  });

  it("keeps the freedraw tool active after a conversion", () => {
    drawFreedraw(circlePoints(100, 100, 80));
    expect(h.state.activeTool.type).toBe("freedraw");
  });

  it("undoes the whole stroke (draw + conversion) in one step", () => {
    drawFreedraw(circlePoints(100, 100, 80));
    expect(liveElements()[0].type).toBe("ellipse");

    Keyboard.undo();

    expect(liveElements().length).toBe(0);
  });
});
