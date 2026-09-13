import { useEffect, useRef, useState } from "react";

import {
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { ServerData, type RemoteCommentThread } from "../../data/ServerData";

import { CommentComposer } from "./CommentComposer";
import { renderRichText } from "./richText";

import "./CommentLayer.scss";

const MIN_REGION_SIZE = 6;

type ScreenRect = { left: number; top: number; width: number; height: number };

const emptyToNull = (value: string) => (value.trim() ? value.trim() : null);

/**
 * Region comments overlaid on the canvas: drag a box to leave a note, click
 * an existing marker to read/reply/resolve. Comments live server-side (see
 * `server/src/store/comments.ts`) so an MCP-connected agent can see the same
 * unresolved threads and act on them — resolving deletes the thread, so the
 * data only exists while it's still actionable.
 */
export const CommentLayer = ({
  excalidrawAPI,
  sceneId,
  active,
  onExitActive,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  sceneId: string;
  active: boolean;
  onExitActive: () => void;
}) => {
  const [comments, setComments] = useState<RemoteCommentThread[]>([]);
  const [, forceTick] = useState(0);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScreenRect | null>(null);
  const [draftText, setDraftText] = useState("");
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const refresh = async () => {
    try {
      setComments(await ServerData.listComments(sceneId));
    } catch {
      // best-effort — the layer just shows nothing until the next refresh
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  // keep marker positions in sync with pan/zoom, which don't otherwise
  // trigger a re-render of this component
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      forceTick((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // live updates: another tab, or an agent via MCP, replied/resolved
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (
          payload.type === "comments-changed" &&
          payload.sceneId === sceneId
        ) {
          void refresh();
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  const viewportRectFor = (thread: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): ScreenRect => {
    const appState = excalidrawAPI.getAppState();
    const topLeft = sceneCoordsToViewportCoords(
      { sceneX: thread.x, sceneY: thread.y },
      appState,
    );
    return {
      left: topLeft.x,
      top: topLeft.y,
      width: thread.width * appState.zoom.value,
      height: thread.height * appState.zoom.value,
    };
  };

  const toScene = (clientX: number, clientY: number) =>
    viewportCoordsToSceneCoords(
      { clientX, clientY },
      excalidrawAPI.getAppState(),
    );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!active) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY };
    setDraft({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) {
      return;
    }
    const { x, y } = dragStart.current;
    setDraft({
      left: Math.min(x, event.clientX),
      top: Math.min(y, event.clientY),
      width: Math.abs(event.clientX - x),
      height: Math.abs(event.clientY - y),
    });
  };

  const handlePointerUp = () => {
    dragStart.current = null;
    if (
      draft &&
      draft.width < MIN_REGION_SIZE &&
      draft.height < MIN_REGION_SIZE
    ) {
      setDraft(null);
    }
    // else: keep `draft` — the note-composer below now renders for it
  };

  const cancelDraft = () => {
    setDraft(null);
    setDraftText("");
  };

  const submitDraft = async () => {
    if (!draft || !emptyToNull(draftText)) {
      return;
    }
    const start = toScene(draft.left, draft.top);
    const end = toScene(draft.left + draft.width, draft.top + draft.height);
    await ServerData.createComment(
      sceneId,
      {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      },
      draftText,
    );
    cancelDraft();
    onExitActive();
    await refresh();
  };

  const openThread =
    comments.find((thread) => thread.id === openThreadId) ?? null;

  return (
    <div className={`comment-layer${active ? " comment-layer-active" : ""}`}>
      {active && (
        <div
          className="comment-layer-capture"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}

      {comments.map((thread) => {
        const rect = viewportRectFor(thread);
        return (
          <div key={thread.id}>
            {/* outline only — never blocks or covers the drawing underneath */}
            <div
              className="comment-region-outline"
              style={{
                left: rect.left,
                top: rect.top,
                width: Math.max(rect.width, 4),
                height: Math.max(rect.height, 4),
              }}
            />
            <button
              type="button"
              className="comment-pin"
              style={{ left: rect.left, top: rect.top }}
              aria-label={`${thread.messages.length} comment${
                thread.messages.length === 1 ? "" : "s"
              }`}
              onClick={() => setOpenThreadId(thread.id)}
            >
              💬
              <span className="comment-pin-badge">
                {thread.messages.length}
              </span>
            </button>
          </div>
        );
      })}

      {draft && (
        <>
          <div
            className="comment-draft-region"
            style={{
              left: draft.left,
              top: draft.top,
              width: draft.width,
              height: draft.height,
            }}
          />
          <div
            className="comment-composer"
            style={{ left: draft.left, top: draft.top + draft.height + 8 }}
          >
            <CommentComposer
              autoFocus
              placeholder="Leave a note about this area…"
              value={draftText}
              onChange={setDraftText}
            />
            <div className="comment-composer-actions">
              <button type="button" onClick={cancelDraft}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!emptyToNull(draftText)}
                onClick={submitDraft}
              >
                Comment
              </button>
            </div>
          </div>
        </>
      )}

      {openThread && (
        <CommentThreadPopover
          thread={openThread}
          anchor={viewportRectFor(openThread)}
          onClose={() => setOpenThreadId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
};

const CommentThreadPopover = ({
  thread,
  anchor,
  onClose,
  onChanged,
}: {
  thread: RemoteCommentThread;
  anchor: ScreenRect;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) => {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const submitReply = async () => {
    if (!emptyToNull(reply)) {
      return;
    }
    setBusy(true);
    try {
      await ServerData.replyToComment(thread.id, reply);
      setReply("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const resolve = async () => {
    setBusy(true);
    try {
      await ServerData.resolveComment(thread.id);
      onClose();
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="comment-thread-popover"
      style={{ left: anchor.left, top: anchor.top + anchor.height + 8 }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="comment-thread-messages">
        {thread.messages.map((message) => (
          <div
            key={message.id}
            className={`comment-message comment-message-${message.author}`}
          >
            <span className="comment-message-author">{message.author}</span>
            <span className="comment-message-text">
              {renderRichText(message.text)}
            </span>
          </div>
        ))}
      </div>
      <CommentComposer placeholder="Reply…" value={reply} onChange={setReply} />
      <div className="comment-thread-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button
          type="button"
          disabled={busy || !emptyToNull(reply)}
          onClick={submitReply}
        >
          Reply
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={resolve}
        >
          Mark resolved
        </button>
      </div>
    </div>
  );
};
