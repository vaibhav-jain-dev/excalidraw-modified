import { Excalidraw } from "../index";
import {
  comboMatchesEvent,
  eventToCombo,
  findKeybindingConflict,
  formatCombo,
  getKeybinding,
  isActionRemapped,
  isToolRemapped,
  matchOverriddenAction,
  matchOverriddenTool,
  resetAllKeybindings,
  setKeybinding,
} from "../keybindings";

import { Keyboard } from "./helpers/ui";
import { act, render } from "./test-utils";

const { h } = window;

const evt = (
  code: string,
  mods: Partial<
    Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
  > = {},
) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("keybindings — combo helpers", () => {
  it("round-trips an event through eventToCombo / comboMatchesEvent", () => {
    const combo = eventToCombo(evt("KeyD", { ctrlKey: true, shiftKey: true }));
    expect(combo).toBe("Mod+Shift+KeyD");
    expect(
      comboMatchesEvent(combo!, evt("KeyD", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(comboMatchesEvent(combo!, evt("KeyD", { ctrlKey: true }))).toBe(
      false,
    );
  });

  it("ignores bare modifier presses", () => {
    expect(eventToCombo(evt("ShiftLeft", { shiftKey: true }))).toBeNull();
  });

  it("formats a combo for display", () => {
    expect(formatCombo("Mod+Shift+KeyD")).toBe("Ctrl+Shift+D");
    expect(formatCombo("Slash")).toBe("/");
    expect(formatCombo("")).toBe("—");
  });
});

describe("keybindings — override store", () => {
  beforeEach(() => resetAllKeybindings());
  afterEach(() => resetAllKeybindings());

  it("overrides and resets a binding", () => {
    expect(getKeybinding("tool.rectangle")).toBe("KeyR");
    expect(isToolRemapped("rectangle")).toBe(false);

    setKeybinding("tool.rectangle", "KeyJ");
    expect(getKeybinding("tool.rectangle")).toBe("KeyJ");
    expect(isToolRemapped("rectangle")).toBe(true);
    expect(matchOverriddenTool(evt("KeyJ"))).toBe("rectangle");

    resetAllKeybindings();
    expect(getKeybinding("tool.rectangle")).toBe("KeyR");
    expect(matchOverriddenTool(evt("KeyJ"))).toBeNull();
  });

  it("maps an event to a remapped action and flags the default as suppressed", () => {
    setKeybinding("action.duplicateSelection", "Mod+KeyE");
    expect(matchOverriddenAction(evt("KeyE", { ctrlKey: true }))).toBe(
      "duplicateSelection",
    );
    expect(isActionRemapped("duplicateSelection")).toBe(true);
    expect(isActionRemapped("group")).toBe(false);
  });

  it("detects a conflict with another binding", () => {
    setKeybinding("tool.rectangle", "KeyL");
    const conflict = findKeybindingConflict("KeyL", "tool.rectangle");
    // "line" still owns its default KeyL
    expect(conflict?.id).toBe("tool.line");
  });
});

describe("keybindings — editor integration", () => {
  beforeEach(async () => {
    resetAllKeybindings();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });
  afterEach(async () => {
    resetAllKeybindings();
    await act(async () => {});
  });

  it("a remapped tool key selects the tool; the old key no longer does", () => {
    setKeybinding("tool.rectangle", "KeyJ");

    // the new combo (matched by `event.code`) selects rectangle
    act(() => Keyboard.codePress("KeyJ"));
    expect(h.state.activeTool.type).toBe("rectangle");

    // built-in tool keys still work for un-remapped tools (matched by `event.key`)
    act(() => Keyboard.keyPress("v"));
    expect(h.state.activeTool.type).toBe("selection");

    // the old rectangle key is now inert
    act(() => Keyboard.keyPress("r"));
    expect(h.state.activeTool.type).toBe("selection");
  });
});
