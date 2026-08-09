import type { CommentMeta } from "../../domain";

export type CommentFilter = "open" | "done" | "all";

export function openCommentsCount(comments: readonly CommentMeta[]): number {
  return comments.filter((comment) => !comment.done).length;
}

export function visibleComments(
  comments: readonly CommentMeta[],
  filter: CommentFilter,
): CommentMeta[] {
  if (filter === "all") return [...comments];
  const done = filter === "done";
  return comments.filter((comment) => comment.done === done);
}

export function emptyCommentsMessage(filter: CommentFilter): string {
  if (filter === "open") return "No open comments.";
  if (filter === "done") return "No done comments.";
  return "No comments yet.";
}
