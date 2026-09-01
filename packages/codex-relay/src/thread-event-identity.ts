import type { StreamThreadRunEvent } from "./api-schema.js";

export function semanticThreadEventId(threadId: string, event: StreamThreadRunEvent) {
  if (event.type === "thread.message.created" && event.message.role === "user") {
    const semanticEventId = event.message.semanticEventId;
    if (!semanticEventId) {
      return undefined;
    }
    const replacementId = event.message.details?.replacesMessageId;
    const stage =
      typeof replacementId === "string" && replacementId && replacementId !== event.message.id
        ? "canonical"
        : "accepted";
    return semanticIdentity(threadId, "input", semanticEventId, "user", stage);
  }
  if (event.type === "thread.input_request.created") {
    return semanticIdentity(threadId, "input-request", event.request.id, "created");
  }
  if (event.type === "thread.input_request.resolved") {
    return semanticIdentity(threadId, "input-request", event.requestId, "resolved");
  }
  return undefined;
}

function semanticIdentity(threadId: string, ...parts: string[]) {
  return ["semantic", "v1", threadId, ...parts].map(encodeURIComponent).join(":");
}
