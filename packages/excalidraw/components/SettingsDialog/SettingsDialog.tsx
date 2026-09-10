import { useEffect, useMemo, useRef, useState } from "react";

import { t, type TranslationKeys } from "../../i18n";
import {
  eventToCombo,
  findKeybindingConflict,
  formatCombo,
  getKeybinding,
  isKeybindingOverridden,
  REMAPPABLE_SHORTCUTS,
  resetAllKeybindings,
  resetKeybinding,
  setKeybinding,
  subscribeToKeybindings,
  type KeybindingId,
  type RemappableShortcut,
} from "../../keybindings";
import { Dialog } from "../Dialog";

import "./SettingsDialog.scss";

/** catalog label keys are plain strings but always exist in the locale data */
const tr = (key: string) => t(key as TranslationKeys);

const Row = ({
  shortcut,
  recording,
  onRecord,
}: {
  shortcut: RemappableShortcut;
  recording: boolean;
  onRecord: (id: KeybindingId | null) => void;
}) => {
  const combo = getKeybinding(shortcut.id);
  const overridden = isKeybindingOverridden(shortcut.id);
  const conflict = overridden
    ? findKeybindingConflict(combo, shortcut.id)
    : null;

  return (
    <div className="SettingsDialog__row">
      <div className="SettingsDialog__label">
        {tr(shortcut.labelKey)}
        {conflict && (
          <span className="SettingsDialog__conflict">
            {t("keybindings.conflict", { name: tr(conflict.labelKey) })}
          </span>
        )}
      </div>
      <button
        type="button"
        className={`SettingsDialog__combo${
          recording ? " SettingsDialog__combo--recording" : ""
        }${overridden ? " SettingsDialog__combo--custom" : ""}`}
        onClick={() => onRecord(recording ? null : shortcut.id)}
        title={t("keybindings.edit")}
      >
        {recording
          ? t("keybindings.recording")
          : combo
          ? formatCombo(combo)
          : t("keybindings.clear")}
      </button>
      <button
        type="button"
        className="SettingsDialog__reset"
        disabled={!overridden}
        onClick={() => {
          resetKeybinding(shortcut.id);
          onRecord(null);
        }}
        title={t("keybindings.reset")}
      >
        ↺
      </button>
    </div>
  );
};

const Section = ({
  title,
  shortcuts,
  recordingId,
  setRecordingId,
}: {
  title: string;
  shortcuts: RemappableShortcut[];
  recordingId: KeybindingId | null;
  setRecordingId: (id: KeybindingId | null) => void;
}) => {
  if (!shortcuts.length) {
    return null;
  }
  return (
    <div className="SettingsDialog__section">
      <h3>{title}</h3>
      {shortcuts.map((shortcut) => (
        <Row
          key={shortcut.id}
          shortcut={shortcut}
          recording={recordingId === shortcut.id}
          onRecord={setRecordingId}
        />
      ))}
    </div>
  );
};

export const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const [, forceRender] = useState(0);
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<KeybindingId | null>(null);
  const recordingRef = useRef(recordingId);
  recordingRef.current = recordingId;

  useEffect(() => subscribeToKeybindings(() => forceRender((n) => n + 1)), []);

  // capture the next keystroke while a row is "recording"
  useEffect(() => {
    if (!recordingId) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = eventToCombo(event);
      if (!combo) {
        return;
      }
      setKeybinding(recordingRef.current as KeybindingId, combo);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingId]);

  const { tools, actions } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const match = (shortcut: RemappableShortcut) =>
      !needle ||
      tr(shortcut.labelKey).toLowerCase().includes(needle) ||
      formatCombo(getKeybinding(shortcut.id)).toLowerCase().includes(needle);
    return {
      tools: REMAPPABLE_SHORTCUTS.filter(
        (s) => s.category === "tool" && match(s),
      ),
      actions: REMAPPABLE_SHORTCUTS.filter(
        (s) => s.category === "action" && match(s),
      ),
    };
  }, [query]);

  return (
    <Dialog
      onCloseRequest={onClose}
      title={t("keybindings.title")}
      className="SettingsDialog"
    >
      <div className="SettingsDialog__toolbar">
        <input
          className="SettingsDialog__search"
          type="search"
          placeholder={t("keybindings.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="SettingsDialog__resetAll"
          onClick={() => {
            resetAllKeybindings();
            setRecordingId(null);
          }}
        >
          {t("keybindings.resetAll")}
        </button>
      </div>
      <p className="SettingsDialog__hint">{t("keybindings.hint")}</p>
      <div className="SettingsDialog__list">
        <Section
          title={t("keybindings.tools")}
          shortcuts={tools}
          recordingId={recordingId}
          setRecordingId={setRecordingId}
        />
        <Section
          title={t("keybindings.actions")}
          shortcuts={actions}
          recordingId={recordingId}
          setRecordingId={setRecordingId}
        />
      </div>
    </Dialog>
  );
};
