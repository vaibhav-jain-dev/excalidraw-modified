import { Fragment } from "react";

import type { ReactNode } from "react";

/**
 * A deliberately small markdown subset for comment bodies — enough for an
 * agent to answer legibly (code spans, emphasis, highlights, lists) without
 * pulling in a parser or ever touching `dangerouslySetInnerHTML`. Everything
 * below returns React nodes, so unmatched syntax degrades to literal text.
 *
 * Inline:  `code`  **bold**  *italic*  _italic_  ==highlight==  ~~strike~~
 * A bare hex colour inside a code span also renders a swatch: `#ff8787`
 * Blocks:  "- item" / "* item" bullets, "1. item" numbers, blank-line breaks
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// order matters: code first, so nothing inside a code span is re-parsed
const INLINE = [
  { re: /`([^`\n]+)`/, tag: "code" as const },
  { re: /\*\*([^*\n]+)\*\*/, tag: "strong" as const },
  { re: /==([^=\n]+)==/, tag: "mark" as const },
  { re: /~~([^~\n]+)~~/, tag: "del" as const },
  { re: /(?:\*|_)([^*_\n]+)(?:\*|_)/, tag: "em" as const },
];

const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  let earliest: { index: number; match: RegExpMatchArray; tag: string } | null =
    null;

  for (const { re, tag } of INLINE) {
    const match = text.match(re);
    if (match?.index !== undefined) {
      if (earliest === null || match.index < earliest.index) {
        earliest = { index: match.index, match, tag };
      }
    }
  }

  if (earliest === null) {
    return text ? [text] : [];
  }

  const { index, match, tag } = earliest;
  const body = match[1];
  const before = text.slice(0, index);
  const after = text.slice(index + match[0].length);
  const key = `${keyPrefix}-${index}`;

  let node: ReactNode;
  if (tag === "code" && HEX.test(body)) {
    node = (
      <code key={key} className="comment-swatch">
        <span
          className="comment-swatch-chip"
          style={{ background: body }}
          aria-hidden="true"
        />
        {body}
      </code>
    );
  } else if (tag === "strong") {
    node = <strong key={key}>{body}</strong>;
  } else if (tag === "mark") {
    node = <mark key={key}>{body}</mark>;
  } else if (tag === "del") {
    node = <del key={key}>{body}</del>;
  } else if (tag === "em") {
    node = <em key={key}>{body}</em>;
  } else {
    node = <code key={key}>{body}</code>;
  }

  return [
    ...(before ? [before] : []),
    node,
    ...renderInline(after, `${key}-x`),
  ];
};

export const renderRichText = (text: string): ReactNode => {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (!list) {
      return;
    }
    const key = `list-${blocks.length}`;
    const items = list.items.map((item, i) => (
      <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
    ));
    blocks.push(
      list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
    );
    list = null;
  };

  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      return;
    }

    flush();
    if (line.trim() === "") {
      // a blank line between paragraphs, not a trailing newline
      if (i > 0 && i < lines.length - 1) {
        blocks.push(<br key={`br-${i}`} />);
      }
      return;
    }
    blocks.push(
      <Fragment key={`p-${i}`}>
        {renderInline(line, `p-${i}`)}
        {i < lines.length - 1 ? "\n" : null}
      </Fragment>,
    );
  });
  flush();

  return blocks;
};
