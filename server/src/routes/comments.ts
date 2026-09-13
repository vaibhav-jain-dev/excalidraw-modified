import type { FastifyInstance, FastifyReply } from "fastify";

import { SceneNotFoundError } from "../store/scenes.ts";
import {
  addMessage,
  CommentNotFoundError,
  createComment,
  listComments,
  resolveComment,
} from "../store/comments.ts";

interface SceneIdParams {
  id: string;
}
interface CommentIdParams {
  commentId: string;
}

const notFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: message });

export const registerCommentRoutes = (app: FastifyInstance): void => {
  app.get<{ Params: SceneIdParams }>(
    "/api/scenes/:id/comments",
    async (request, reply) => {
      try {
        return { comments: listComments(request.params.id) };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: SceneIdParams }>(
    "/api/scenes/:id/comments",
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        text?: string;
        author?: string;
      };
      if (!body.text || !body.text.trim()) {
        return reply.code(400).send({ error: "comment text is required" });
      }
      try {
        const comment = createComment(
          request.params.id,
          {
            x: Number(body.x) || 0,
            y: Number(body.y) || 0,
            width: Number(body.width) || 0,
            height: Number(body.height) || 0,
          },
          body.text,
          body.author?.trim() || "user",
        );
        reply.code(201);
        return { comment };
      } catch (error) {
        if (error instanceof SceneNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: CommentIdParams }>(
    "/api/comments/:commentId/messages",
    async (request, reply) => {
      const body = (request.body ?? {}) as { text?: string; author?: string };
      if (!body.text || !body.text.trim()) {
        return reply.code(400).send({ error: "message text is required" });
      }
      try {
        const comment = addMessage(
          request.params.commentId,
          body.text,
          body.author?.trim() || "user",
        );
        return { comment };
      } catch (error) {
        if (error instanceof CommentNotFoundError) {
          return notFound(reply, error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: CommentIdParams }>(
    "/api/comments/:commentId",
    async (request, reply) => {
      if (!resolveComment(request.params.commentId)) {
        return notFound(reply, "comment not found");
      }
      return reply.code(204).send();
    },
  );
};
