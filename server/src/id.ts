import { randomBytes } from "node:crypto";

/**
 * Scene id: a millisecond timestamp in base36 plus 5 random bytes. Roughly
 * time-sortable, URL-safe, and short enough to live in a `#local=<id>` hash.
 */
export const newId = (): string =>
  `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
