import type { ChatMessage } from "@aias00/codex-relay/api-schema";

export function messageKeyExtractor(message: ChatMessage) {
  return message.id;
}

export function messageItemType(message: ChatMessage) {
  if (message.kind === "plan") {
    return "plan";
  }
  if (message.kind === "fileChange") {
    return "protocol";
  }
  if (message.role === "status" || message.role === "tool" || message.role === "reasoning") {
    return "meta";
  }
  if (message.kind !== "chat" && message.kind !== "unknown") {
    return "protocol";
  }
  return message.role;
}
