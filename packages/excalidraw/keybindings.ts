/**
 * User-customizable keyboard shortcuts.
 *
 * Excalidraw's key handling lives in per-action `keyTest` functions and the
 * tool-key lookup (`findShapeByKey`). Rather than rewrite all of that, this
 * module keeps a small override table (persisted to localStorage) that two hot
 * paths consult:
 *
 *   - `ActionManager.handleKeyDown` — a remapped action's combo wins over the
 *     default `keyTest`s, and the remapped action's own default `keyTest` is
 *     suppressed.
 *   - `findShapeByKey` — a remapped tool's combo replaces its letter/digit key.
 *
 * A combo is a `"Mod+Shift+KeyD"` string: optional modifiers (`Mod` = Ctrl on
 * Windows/Linux, Cmd on macOS; then `Alt`, then `Shift`) plus one
 * `KeyboardEvent.code`. `""` means "unbound".
 *
 * Out of scope: shortcuts wired to hardcoded `event.key` checks in `App.tsx`
 * (canvas panning, arrow-key nudging, a few one-offs). Those keep their
 * built-in keys.
 */

import { EDITOR_LS_KEYS, isDarwin } from "@excalidraw/common";

import { EditorLocalStorage } from "./data/EditorLocalStorage";

import type { ShortcutName } from "./actions/shortcuts";
import type { ToolType } from "./types";

export type KeybindingCategory = "tool" | "action";

export type KeybindingId = `tool.${string}` | `action.${ShortcutName}`;

// ---------------------------------------------------------------------------
// combo parsing / matching / formatting
// ---------------------------------------------------------------------------

type ParsedCombo = { mod: boolean; alt: boolean; shift: boolean; code: string };

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

const parseCombo = (combo: string): ParsedCombo | null => {
  if (!combo) {
    return null;
  }
  const parts = combo.split("+");
  const code = parts.pop();
  if (!code) {
    return null;
  }
  return {
    mod: parts.includes("Mod"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    code,
  };
};

type KeyEventLike = Pick<
  KeyboardEvent,
  "code" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey"
>;

/** Build a combo string from a keydown event, or `null` for a bare modifier. */
export const eventToCombo = (event: KeyEventLike): string | null => {
  if (!event.code || MODIFIER_CODES.has(event.code)) {
    return null;
  }
  const parts: string[] = [];
  if (isDarwin ? event.metaKey : event.ctrlKey) {
    parts.push("Mod");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(event.code);
  return parts.join("+");
};

export const comboMatchesEvent = (
  combo: string,
  event: KeyEventLike,
): boolean => {
  const parsed = parseCombo(combo);
  if (!parsed) {
    return false;
  }
  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  return (
    mod === parsed.mod &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.code === parsed.code
  );
};

const CODE_LABELS: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Del",
  Tab: "Tab",
};

const codeLabel = (code: string): string => {
  if (CODE_LABELS[code]) {
    return CODE_LABELS[code];
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Digit")) {
    return code.slice(5);
  }
  if (code.startsWith("Numpad")) {
    return `Num${code.slice(6)}`;
  }
  if (code.startsWith("Arrow")) {
    return code.slice(5);
  }
  return code;
};

/** Human-readable form, e.g. `"⌘⇧D"` (mac) or `"Ctrl+Shift+D"`. */
export const formatCombo = (combo: string): string => {
  const parsed = parseCombo(combo);
  if (!parsed) {
    return "—";
  }
  const key = codeLabel(parsed.code);
  if (isDarwin) {
    return `${parsed.mod ? "⌘" : ""}${parsed.alt ? "⌥" : ""}${
      parsed.shift ? "⇧" : ""
    }${key}`;
  }
  return [
    parsed.mod && "Ctrl",
    parsed.alt && "Alt",
    parsed.shift && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
};

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

export interface RemappableShortcut {
  id: KeybindingId;
  category: KeybindingCategory;
  /** i18n key for the row label */
  labelKey: string;
  /** default combo (`""` when the built-in default isn't a single combo) */
  default: string;
}

const TOOLS: ReadonlyArray<[string, string, string]> = [
  ["selection", "toolBar.selection", "KeyV"],
  ["rectangle", "toolBar.rectangle", "KeyR"],
  ["diamond", "toolBar.diamond", "KeyD"],
  ["ellipse", "toolBar.ellipse", "KeyO"],
  ["arrow", "toolBar.arrow", "KeyA"],
  ["line", "toolBar.line", "KeyL"],
  ["freedraw", "toolBar.freedraw", "KeyP"],
  ["autoshape", "toolBar.autoshape", "Shift+KeyX"],
  ["text", "toolBar.text", "KeyT"],
  ["image", "toolBar.image", "Digit9"],
  ["eraser", "toolBar.eraser", "KeyE"],
  ["frame", "toolBar.frame", "KeyF"],
  ["stickynote", "toolBar.stickynote", "KeyN"],
  ["laser", "toolBar.laser", "KeyK"],
  ["hand", "toolBar.hand", "KeyH"],
];

const ACTIONS: ReadonlyArray<[ShortcutName, string, string]> = [
  ["selectAll", "labels.selectAll", "Mod+KeyA"],
  ["deleteSelectedElements", "labels.delete", "Delete"],
  ["duplicateSelection", "labels.duplicateSelection", "Mod+KeyD"],
  ["group", "labels.group", "Mod+KeyG"],
  ["ungroup", "labels.ungroup", "Mod+Shift+KeyG"],
  ["cut", "labels.cut", "Mod+KeyX"],
  ["copy", "labels.copy", "Mod+KeyC"],
  ["paste", "labels.paste", "Mod+KeyV"],
  ["copyStyles", "labels.copyStyles", "Mod+Alt+KeyC"],
  ["pasteStyles", "labels.pasteStyles", "Mod+Alt+KeyV"],
  [
    "sendToBack",
    "labels.sendToBack",
    isDarwin ? "Mod+Alt+BracketLeft" : "Mod+Shift+BracketLeft",
  ],
  [
    "bringToFront",
    "labels.bringToFront",
    isDarwin ? "Mod+Alt+BracketRight" : "Mod+Shift+BracketRight",
  ],
  ["sendBackward", "labels.sendBackward", "Mod+BracketLeft"],
  ["bringForward", "labels.bringForward", "Mod+BracketRight"],
  ["flipHorizontal", "labels.flipHorizontal", "Shift+KeyH"],
  ["flipVertical", "labels.flipVertical", "Shift+KeyV"],
  ["toggleElementLock", "keybindings.toggleElementLock", "Mod+Shift+KeyL"],
  ["hyperlink", "keybindings.hyperlink", "Mod+KeyK"],
  ["zoomIn", "keybindings.zoomIn", "Mod+Equal"],
  ["zoomOut", "keybindings.zoomOut", "Mod+Minus"],
  ["resetZoom", "keybindings.resetZoom", "Mod+Digit0"],
  ["zoomToFit", "labels.zoomToFit", "Shift+Digit1"],
  [
    "zoomToFitSelectionInViewport",
    "helpDialog.zoomToSelection",
    "Shift+Digit2",
  ],
  ["gridMode", "labels.toggleGrid", "Mod+Quote"],
  ["zenMode", "buttons.zenMode", "Alt+KeyZ"],
  ["viewMode", "labels.viewMode", "Alt+KeyR"],
  ["objectsSnapMode", "keybindings.snapMode", "Alt+KeyS"],
  ["stats", "keybindings.stats", "Alt+Slash"],
  ["toggleShortcuts", "helpDialog.title", "Shift+Slash"],
  ["searchMenu", "keybindings.search_action", "Mod+KeyF"],
  ["saveFileToDisk", "keybindings.save", "Mod+KeyS"],
  ["loadScene", "keybindings.open", "Mod+KeyO"],
  ["toggleTheme", "labels.toggleTheme", "Shift+Alt+KeyD"],
];

const seen = new Set<string>();

export const REMAPPABLE_SHORTCUTS: readonly RemappableShortcut[] = [
  ...TOOLS.map(
    ([type, labelKey, def]): RemappableShortcut => ({
      id: `tool.${type}`,
      category: "tool",
      labelKey,
      default: def,
    }),
  ),
  ...ACTIONS.filter(([name]) => {
    if (seen.has(name)) {
      return false;
    }
    seen.add(name);
    return true;
  }).map(
    ([name, labelKey, def]): RemappableShortcut => ({
      id: `action.${name}`,
      category: "action",
      labelKey,
      default: def,
    }),
  ),
];

const BY_ID = new Map(REMAPPABLE_SHORTCUTS.map((s) => [s.id, s]));

const actionNameFromId = (id: KeybindingId): ShortcutName | null =>
  id.startsWith("action.") ? (id.slice(7) as ShortcutName) : null;

const toolTypeFromId = (id: KeybindingId): string | null =>
  id.startsWith("tool.") ? id.slice(5) : null;

// ---------------------------------------------------------------------------
// override store
// ---------------------------------------------------------------------------

type Overrides = Partial<Record<KeybindingId, string>>;

let overrides: Overrides = load();
const listeners = new Set<() => void>();

function load(): Overrides {
  const stored = EditorLocalStorage.get<Overrides>(EDITOR_LS_KEYS.KEYBINDINGS);
  if (!stored || typeof stored !== "object") {
    return {};
  }
  const clean: Overrides = {};
  for (const [id, combo] of Object.entries(stored)) {
    if (BY_ID.has(id as KeybindingId) && typeof combo === "string") {
      clean[id as KeybindingId] = combo;
    }
  }
  return clean;
}

const persist = () => {
  EditorLocalStorage.set(EDITOR_LS_KEYS.KEYBINDINGS, overrides);
  listeners.forEach((listener) => listener());
};

export const subscribeToKeybindings = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getKeybinding = (id: KeybindingId): string =>
  overrides[id] ?? BY_ID.get(id)?.default ?? "";

export const isKeybindingOverridden = (id: KeybindingId): boolean =>
  id in overrides;

export const setKeybinding = (id: KeybindingId, combo: string): void => {
  if (!BY_ID.has(id)) {
    return;
  }
  overrides = { ...overrides, [id]: combo };
  persist();
};

export const resetKeybinding = (id: KeybindingId): void => {
  if (!(id in overrides)) {
    return;
  }
  const next = { ...overrides };
  delete next[id];
  overrides = next;
  persist();
};

export const resetAllKeybindings = (): void => {
  overrides = {};
  persist();
};

/** For a keydown event, the id another shortcut's binding already claims. */
export const findKeybindingConflict = (
  combo: string,
  exceptId: KeybindingId,
): RemappableShortcut | null => {
  if (!combo) {
    return null;
  }
  for (const shortcut of REMAPPABLE_SHORTCUTS) {
    if (shortcut.id !== exceptId && getKeybinding(shortcut.id) === combo) {
      return shortcut;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// hot-path lookups
// ---------------------------------------------------------------------------

/** The action a user override maps this keydown to (or null). */
export const matchOverriddenAction = (
  event: KeyEventLike,
): ShortcutName | null => {
  for (const [id, combo] of Object.entries(overrides) as [
    KeybindingId,
    string,
  ][]) {
    const name = actionNameFromId(id);
    if (name && combo && comboMatchesEvent(combo, event)) {
      return name;
    }
  }
  return null;
};

/** Whether the action's built-in `keyTest` should be ignored (user remapped it). */
export const isActionRemapped = (name: string): boolean =>
  `action.${name}` in overrides;

/** The tool a user override selects for this keydown (or null). */
export const matchOverriddenTool = (event: KeyEventLike): ToolType | null => {
  for (const [id, combo] of Object.entries(overrides) as [
    KeybindingId,
    string,
  ][]) {
    const type = toolTypeFromId(id);
    if (type && combo && comboMatchesEvent(combo, event)) {
      return type as ToolType;
    }
  }
  return null;
};

export const isToolRemapped = (type: string): boolean =>
  `tool.${type}` in overrides;
