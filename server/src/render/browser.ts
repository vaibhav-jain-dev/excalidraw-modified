/**
 * Server-side PNG rendering for scenes that were never opened in a browser
 * (so have no client-rendered thumbnail) — e.g. a scene MCP created.
 *
 * There's no headless "run the exporter" harness here; instead this drives a
 * persistent headless Chromium to the app's own `/d/<id>` page and reuses the
 * running editor instance (`window.h`, exposed in dev builds) to zoom-to-fit
 * (or zoom-to-anchor) and screenshot the real static canvas. That means it
 * only works when `EXCALIDRAW_LOCAL_RENDER_ORIGIN` (default: this server)
 * points at a **dev** Vite server — a production build doesn't expose
 * `window.h`. Best-effort by design: every failure mode throws a clear error
 * that callers (the HTTP route, the MCP tool) turn into "no preview".
 */

import fs from "node:fs";

import puppeteer, { type Browser } from "puppeteer-core";

import { config } from "../config.ts";

// the functions passed to `page.evaluate` below run in the browser, not here —
// this just satisfies the (DOM-less) server tsconfig for their source text
declare const window: any;

const CHROME_CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const resolveChromePath = (): string | null => {
  if (config.chromePath) {
    return config.chromePath;
  }
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
};

let browserPromise: Promise<Browser> | null = null;

const getBrowser = async (): Promise<Browser> => {
  if (browserPromise) {
    return browserPromise;
  }
  const executablePath = resolveChromePath();
  if (!executablePath) {
    throw new Error(
      "No Chromium found for server-side rendering. Set CHROME_PATH to a " +
        "Chrome/Chromium binary, or install one at a standard location.",
    );
  }
  browserPromise = puppeteer
    .launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    })
    .catch((error) => {
      browserPromise = null; // let the next call retry
      throw error;
    });
  return browserPromise;
};

export interface RenderOptions {
  /** crop to the element tagged with this `customData.anchor` */
  anchor?: string;
  width?: number;
  height?: number;
}

const NAV_TIMEOUT_MS = 30_000;
const EDITOR_READY_TIMEOUT_MS = 15_000;
const PAINT_SETTLE_MS = 350;

export const renderScenePng = async (
  sceneId: string,
  options: RenderOptions = {},
): Promise<Buffer> => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: options.width ?? 1280,
      height: options.height ?? 900,
    });

    const url = `${config.renderAppOrigin}/d/${encodeURIComponent(sceneId)}`;
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: NAV_TIMEOUT_MS,
    });

    await page
      .waitForFunction(
        () => {
          const h = (window as any).h;
          return !!h?.app?.actionManager && Array.isArray(h?.elements);
        },
        { timeout: EDITOR_READY_TIMEOUT_MS },
      )
      .catch(() => {
        throw new Error(
          "editor did not become ready — is EXCALIDRAW_LOCAL_RENDER_ORIGIN " +
            "pointed at a running *dev* server (window.h is dev-only)?",
        );
      });

    if (options.anchor) {
      const elementId = await page.evaluate((anchor: string) => {
        const h = (window as any).h;
        const element = h.elements.find(
          (el: any) => !el.isDeleted && el.customData?.anchor === anchor,
        );
        return element ? element.id : null;
      }, options.anchor);

      if (!elementId) {
        throw new Error(`no element anchored "${options.anchor}"`);
      }

      // two round trips, not one: `setState` is async (React batches even
      // outside an event handler), so the zoom action must run after it has
      // actually flushed, or it reads the stale (empty) selection
      await page.evaluate((id: string) => {
        (window as any).h.setState({ selectedElementIds: { [id]: true } });
      }, elementId);
      await page.waitForFunction(
        (id: string) =>
          !!(window as any).h.state.selectedElementIds[id],
        {},
        elementId,
      );
      // (not zoomToFitSelectionInViewport, which only ever zooms *out* to
      // fit — a small anchored element would render at the same 100% as an
      // unzoomed full-scene shot)
      await page.evaluate((actionName: string) => {
        const h = (window as any).h;
        const action = h.app.actionManager.actions[actionName];
        if (action) {
          h.app.actionManager.executeAction(action);
        }
      }, "zoomToFitSelection");

      // deselect so the crop shows the drawing, not selection handles and
      // the properties panel
      await page.evaluate(() => {
        (window as any).h.setState({ selectedElementIds: {} });
      });
    } else {
      await page.evaluate((actionName: string) => {
        const h = (window as any).h;
        const action = h.app.actionManager.actions[actionName];
        if (action) {
          h.app.actionManager.executeAction(action);
        }
      }, "zoomToFit");
    }

    await new Promise((resolve) => setTimeout(resolve, PAINT_SETTLE_MS));

    const canvas = await page.$("canvas.excalidraw__canvas.static");
    if (!canvas) {
      throw new Error("could not find the editor canvas to screenshot");
    }
    const png = await canvas.screenshot({ type: "png" });
    return Buffer.from(png);
  } finally {
    await page.close().catch(() => {});
  }
};

export const closeRenderBrowser = async (): Promise<void> => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close().catch(() => {});
  }
};
