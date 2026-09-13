import { broadcastCommentsChanged } from "../events.ts";
import { db, queryRow, queryRows } from "../db.ts";
import { newId } from "../id.ts";
import { getSceneSummary, SceneNotFoundError } from "./scenes.ts";

/**
 * Region comments: a marked rectangle on a scene plus a message thread, so a
 * reviewer can point at something and an agent (via MCP) can see exactly
 * what's unresolved. Resolving a comment deletes it and its messages — once
 * addressed there's nothing worth keeping.
 */

export interface CommentMessage {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  sceneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
  messages: CommentMessage[];
}

interface CommentRow {
  id: string;
  scene_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  comment_id: string;
  author: string;
  text: string;
  created_at: string;
}

const rowToMessage = (row: MessageRow): CommentMessage => ({
  id: row.id,
  author: row.author,
  text: row.text,
  createdAt: row.created_at,
});

const hydrate = (row: CommentRow): CommentThread => ({
  id: row.id,
  sceneId: row.scene_id,
  x: row.x,
  y: row.y,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  messages: queryRows<MessageRow>(
    `SELECT * FROM comment_messages WHERE comment_id = ? ORDER BY created_at ASC`,
    row.id,
  ).map(rowToMessage),
});

export const listComments = (sceneId: string): CommentThread[] => {
  if (!getSceneSummary(sceneId)) {
    throw new SceneNotFoundError(sceneId);
  }
  return queryRows<CommentRow>(
    `SELECT * FROM comments WHERE scene_id = ? ORDER BY created_at ASC`,
    sceneId,
  ).map(hydrate);
};

export const getComment = (id: string): CommentThread | null => {
  const row = queryRow<CommentRow>("SELECT * FROM comments WHERE id = ?", id);
  return row ? hydrate(row) : null;
};

export const createComment = (
  sceneId: string,
  region: { x: number; y: number; width: number; height: number },
  text: string,
  author = "user",
): CommentThread => {
  if (!getSceneSummary(sceneId)) {
    throw new SceneNotFoundError(sceneId);
  }
  const id = newId();
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO comments (id, scene_id, x, y, width, height, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sceneId, region.x, region.y, region.width, region.height, now, now);
    db.prepare(
      `INSERT INTO comment_messages (id, comment_id, author, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), id, author, text.trim(), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  broadcastCommentsChanged(sceneId);
  return getComment(id) as CommentThread;
};

export class CommentNotFoundError extends Error {
  constructor(id: string) {
    super(`comment not found: ${id}`);
    this.name = "CommentNotFoundError";
  }
}

export const addMessage = (
  commentId: string,
  text: string,
  author = "user",
): CommentThread => {
  const comment = getComment(commentId);
  if (!comment) {
    throw new CommentNotFoundError(commentId);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO comment_messages (id, comment_id, author, text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), commentId, author, text.trim(), now);
  db.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(
    now,
    commentId,
  );

  broadcastCommentsChanged(comment.sceneId);
  return getComment(commentId) as CommentThread;
};

/** Resolving a comment removes it (and its thread) entirely — nothing to archive. */
export const resolveComment = (commentId: string): boolean => {
  const comment = getComment(commentId);
  if (!comment) {
    return false;
  }
  db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
  broadcastCommentsChanged(comment.sceneId);
  return true;
};
