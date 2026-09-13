import { useRef, useState } from "react";

import { renderRichText } from "./richText";

/**
 * The comment input: a textarea plus the formatting the renderer understands
 * (see `./richText.tsx`). Without this the syntax is only discoverable if you
 * already know it — an agent can write `**bold**`, a person has to be told.
 *
 * Every button works on the current selection: with text selected it wraps it,
 * with nothing selected it inserts the markers and puts the caret between them.
 */

type Wrap = { label: string; title: string; before: string; after: string };
type Prefix = { label: string; title: string; prefix: (i: number) => string };

const WRAPS: Wrap[] = [
  { label: "B", title: "Bold", before: "**", after: "**" },
  { label: "I", title: "Italic", before: "*", after: "*" },
  { label: "</>", title: "Code", before: "`", after: "`" },
  { label: "H", title: "Highlight", before: "==", after: "==" },
  { label: "S", title: "Strikethrough", before: "~~", after: "~~" },
];

const PREFIXES: Prefix[] = [
  { label: "•", title: "Bullet list", prefix: () => "- " },
  { label: "1.", title: "Numbered list", prefix: (i) => `${i + 1}. ` },
];

export const CommentComposer = ({
  value,
  onChange,
  placeholder,
  rows = 2,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const apply = (next: string, caret: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (node) {
        node.focus();
        node.setSelectionRange(caret, caret);
      }
    });
  };

  const wrap = ({ before, after }: Wrap) => {
    const node = ref.current;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const next =
      value.slice(0, start) + before + selected + after + value.slice(end);
    apply(next, start + before.length + selected.length);
  };

  const linePrefix = ({ prefix }: Prefix) => {
    const node = ref.current;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? value.length;
    // grow the selection out to whole lines, so a partial one still works
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const toIndex = value.indexOf("\n", end);
    const to = toIndex === -1 ? value.length : toIndex;
    const block = value.slice(from, to) || "";
    const marked = block
      .split("\n")
      .map((line, i) => (line.trim() ? prefix(i) + line : line))
      .join("\n");
    apply(
      value.slice(0, from) + marked + value.slice(to),
      from + marked.length,
    );
  };

  return (
    <div className="comment-composer-box">
      <div className="comment-toolbar">
        {WRAPS.map((item) => (
          <button
            key={item.label}
            type="button"
            title={item.title}
            aria-label={item.title}
            className={`comment-tool comment-tool-${item.title.toLowerCase()}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => wrap(item)}
          >
            {item.label}
          </button>
        ))}
        <span className="comment-toolbar-sep" />
        {PREFIXES.map((item) => (
          <button
            key={item.label}
            type="button"
            title={item.title}
            aria-label={item.title}
            className="comment-tool"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => linePrefix(item)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="comment-tool comment-tool-preview"
          aria-pressed={preview}
          title={preview ? "Back to editing" : "Preview"}
          disabled={!value.trim()}
          onClick={() => setPreview((on) => !on)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div className="comment-preview comment-message-text">
          {renderRichText(value)}
        </div>
      ) : (
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          rows={rows}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
};
