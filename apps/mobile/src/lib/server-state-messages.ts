import type {
  ChatMessage,
  QueuedThreadInput,
  ThreadDetailResponse,
  ThreadSummary,
} from "codex-relay/api-schema";
import {
  chatMessageDetailsFromPromptContext,
  promptMarkdownWithSkills,
} from "codex-relay/api-schema";

const optimisticSteeringMessageIdPrefix = "optimistic-steering:";
const optimisticRunMessageIdPrefix = "optimistic-run:";

export function optimisticRunMessageId(clientEventId: string) {
  return `${optimisticRunMessageIdPrefix}${clientEventId}`;
}

export function appendOptimisticRunMessageToDetail(
  current: ThreadDetailResponse | undefined,
  options: {
    input: QueuedThreadInput;
    nowIso: string;
    thread: ThreadSummary | undefined;
    threadId: string;
  },
): ThreadDetailResponse | undefined {
  const thread = current?.thread ?? options.thread;
  if (!thread) {
    return current;
  }
  const message: ChatMessage = {
    id: optimisticRunMessageId(options.input.id),
    threadId: options.threadId,
    role: "user",
    kind: "chat",
    content: promptMarkdownWithSkills(options.input.prompt, options.input.skills),
    createdAt: options.nowIso,
    details: chatMessageDetailsFromPromptContext(options.input),
    semanticEventId: options.input.clientEventId ?? options.input.id,
    state: "completed",
  };
  return {
    ...(current ?? {
      thread,
      pendingInputRequests: [],
      hasOlderMessages: false,
    }),
    thread,
    messages: upsertMessage(current?.messages ?? [], message),
  };
}

export function appendOptimisticSteeringMessageToDetail(
  current: ThreadDetailResponse | undefined,
  options: {
    input: QueuedThreadInput;
    nowIso: string;
    thread: ThreadSummary | undefined;
    threadId: string;
  },
): ThreadDetailResponse | undefined {
  const thread = current?.thread ?? options.thread;
  if (!thread) {
    return current;
  }
  const message: ChatMessage = {
    id: optimisticSteeringMessageId(options.input.id),
    threadId: options.threadId,
    role: "user",
    kind: "chat",
    content: promptMarkdownWithSkills(options.input.prompt, options.input.skills),
    createdAt: options.nowIso,
    details: chatMessageDetailsFromPromptContext(options.input, {
      optimisticQueuedInputId: options.input.id,
    }),
    semanticEventId: options.input.clientEventId ?? options.input.id,
    state: "completed",
  };
  return {
    thread,
    messages: upsertMessage(current?.messages ?? [], message),
    pendingInputRequests: current?.pendingInputRequests ?? [],
    hasMoreMessages: current?.hasMoreMessages ?? false,
    hasOlderMessages: current?.hasOlderMessages ?? false,
    ...(current?.messageCursor ? { messageCursor: current.messageCursor } : {}),
    messageCursorReset: current?.messageCursorReset ?? false,
    ...(current?.olderMessagesCursor ? { olderMessagesCursor: current.olderMessagesCursor } : {}),
  };
}

export function mergeThreadDetailState(
  current: ThreadDetailResponse | undefined,
  response: ThreadDetailResponse,
  authoritativeThreadState = false,
) {
  if (!current || current.thread.id !== response.thread.id) {
    return response;
  }
  const messages = mergeMessages(current.messages, response.messages);
  const preservesOlderHistory =
    !response.messageCursorReset &&
    response.olderMessagesCursor === undefined &&
    current.olderMessagesCursor !== undefined;
  return {
    ...response,
    thread: authoritativeThreadState
      ? response.thread
      : preferredThreadSnapshot(current.thread, response.thread),
    messages,
    ...(preservesOlderHistory
      ? {
          hasOlderMessages: current.hasOlderMessages,
          olderMessagesCursor: current.olderMessagesCursor,
        }
      : {}),
    ...(response.messageCursor
      ? { messageCursor: response.messageCursor }
      : current.messageCursor
        ? { messageCursor: current.messageCursor }
        : {}),
  };
}

export function upsertMessage(messages: ChatMessage[], message: ChatMessage) {
  const replacementId = replacementMessageId(message);
  const existingIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (existingIndex !== -1) {
    return messages.flatMap((candidate, index) => {
      if (candidate.id === replacementId && candidate.id !== message.id) {
        return [];
      }
      return [index === existingIndex ? preferredMessageSnapshot(candidate, message) : candidate];
    });
  }
  const semanticIndex = message.semanticEventId
    ? messages.findIndex(
        (candidate) =>
          candidate.id !== message.id && candidate.semanticEventId === message.semanticEventId,
      )
    : -1;
  if (semanticIndex !== -1) {
    return messages.map((candidate, index) =>
      index === semanticIndex ? preferredSemanticMessage(candidate, message) : candidate,
    );
  }
  if (messages.some((candidate) => replacementMessageId(candidate) === message.id)) {
    return messages;
  }
  const replacementIndex = replacementId
    ? messages.findIndex((candidate) => candidate.id === replacementId)
    : -1;
  if (replacementIndex !== -1) {
    return messages.map((candidate, index) => (index === replacementIndex ? message : candidate));
  }
  const optimisticIndex =
    message.role === "user"
      ? messages.findIndex(
          (candidate) =>
            isOptimisticUserMessage(candidate) &&
            candidate.role === "user" &&
            candidate.content === message.content,
        )
      : -1;
  if (optimisticIndex !== -1) {
    return messages.map((candidate, index) => (index === optimisticIndex ? message : candidate));
  }
  const transientDuplicateIndex = messages.findIndex((candidate) =>
    isTransientCanonicalUserPair(candidate, message),
  );
  if (transientDuplicateIndex !== -1) {
    if (isTransientRelayUserMessageId(message.id)) {
      return messages;
    }
    return messages.map((candidate, index) =>
      index === transientDuplicateIndex ? message : candidate,
    );
  }
  const lastMessage = messages[messages.length - 1];
  if (isDuplicateOptimisticQueuedMessage(lastMessage, message)) {
    return messages.map((candidate, index) =>
      index === messages.length - 1 ? message : candidate,
    );
  }
  return sortMessagesByCreation([...messages, message]);
}

function optimisticSteeringMessageId(inputId: string) {
  return `${optimisticSteeringMessageIdPrefix}${inputId}`;
}

function isOptimisticUserMessage(message: ChatMessage) {
  return (
    message.id.startsWith(optimisticSteeringMessageIdPrefix) ||
    message.id.startsWith(optimisticRunMessageIdPrefix)
  );
}

function mergeMessages(baseMessages: ChatMessage[], incomingMessages: ChatMessage[]) {
  const replacedMessageIds = new Set(
    [...baseMessages, ...incomingMessages]
      .map(replacementMessageId)
      .filter((id): id is string => id !== undefined),
  );
  const baseById = new Map(baseMessages.map((message) => [message.id, message]));
  const incomingById = new Map(
    incomingMessages.map((message) => [
      message.id,
      baseById.has(message.id)
        ? preferredMessageSnapshot(baseById.get(message.id)!, message)
        : message,
    ]),
  );
  const indexesById = new Map<string, number>();
  const seenIds = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const candidate of [...baseMessages, ...incomingMessages]) {
    const message = incomingById.get(candidate.id) ?? candidate;
    if (seenIds.has(message.id) || replacedMessageIds.has(message.id)) {
      continue;
    }
    const replacementId = replacementMessageId(message);
    if (replacementId) {
      const replacementIndex = indexesById.get(replacementId);
      if (replacementIndex !== undefined) {
        messages[replacementIndex] = message;
        seenIds.delete(replacementId);
        seenIds.add(message.id);
        indexesById.delete(replacementId);
        indexesById.set(message.id, replacementIndex);
        continue;
      }
    }
    const lastMessage = messages[messages.length - 1];
    if (isDuplicateOptimisticQueuedMessage(lastMessage, message)) {
      messages[messages.length - 1] = message;
      seenIds.delete(lastMessage.id);
      seenIds.add(message.id);
      indexesById.delete(lastMessage.id);
      indexesById.set(message.id, messages.length - 1);
      continue;
    }
    seenIds.add(message.id);
    indexesById.set(message.id, messages.length);
    messages.push(message);
  }
  return dedupeTransientCanonicalUsers(dedupeSemanticMessages(sortMessagesByCreation(messages)));
}

function dedupeSemanticMessages(messages: ChatMessage[]) {
  const deduped: ChatMessage[] = [];
  const indexesBySemanticEventId = new Map<string, number>();
  for (const message of messages) {
    const semanticEventId = message.semanticEventId;
    const existingIndex = semanticEventId
      ? indexesBySemanticEventId.get(semanticEventId)
      : undefined;
    if (existingIndex === undefined) {
      if (semanticEventId) {
        indexesBySemanticEventId.set(semanticEventId, deduped.length);
      }
      deduped.push(message);
      continue;
    }
    deduped[existingIndex] = preferredSemanticMessage(deduped[existingIndex]!, message);
  }
  return deduped;
}

function dedupeTransientCanonicalUsers(messages: ChatMessage[]) {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (!previous || !isTransientCanonicalUserPair(previous, message)) {
      deduped.push(message);
      continue;
    }
    if (isTransientRelayUserMessageId(previous.id)) {
      deduped[deduped.length - 1] = message;
    }
  }
  return deduped;
}

function isTransientCanonicalUserPair(left: ChatMessage, right: ChatMessage) {
  const leftIsTransient = isTransientRelayUserMessageId(left.id);
  const rightIsTransient = isTransientRelayUserMessageId(right.id);
  if (
    left.id === right.id ||
    left.threadId !== right.threadId ||
    left.role !== "user" ||
    right.role !== "user" ||
    left.kind !== right.kind ||
    left.content !== right.content ||
    leftIsTransient === rightIsTransient
  ) {
    return false;
  }
  const elapsedMs = Math.abs(Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return Number.isFinite(elapsedMs) && elapsedMs <= 10_000;
}

function isTransientRelayUserMessageId(id: string) {
  return /^msg-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function preferredMessageSnapshot(current: ChatMessage, incoming: ChatMessage) {
  const currentUpdatedAt = current.updatedAt ?? current.createdAt;
  const incomingUpdatedAt = incoming.updatedAt ?? incoming.createdAt;
  if (currentUpdatedAt !== incomingUpdatedAt) {
    return currentUpdatedAt > incomingUpdatedAt ? current : incoming;
  }
  if (current.state === "completed" && incoming.state !== "completed") {
    return current;
  }
  return incoming;
}

function preferredSemanticMessage(current: ChatMessage, incoming: ChatMessage) {
  const currentIsOptimistic = isOptimisticUserMessage(current);
  const incomingIsOptimistic = isOptimisticUserMessage(incoming);
  if (currentIsOptimistic !== incomingIsOptimistic) {
    return currentIsOptimistic ? incoming : current;
  }
  if (replacementMessageId(incoming) === current.id) {
    return incoming;
  }
  if (replacementMessageId(current) === incoming.id) {
    return current;
  }
  return preferredMessageSnapshot(current, incoming);
}

export function preferredThreadSnapshot(current: ThreadSummary, incoming: ThreadSummary) {
  if (current.updatedAt !== incoming.updatedAt) {
    return current.updatedAt > incoming.updatedAt ? current : incoming;
  }
  if (current.state !== "running" && incoming.state === "running") {
    return current;
  }
  return incoming;
}

function sortMessagesByCreation(messages: ChatMessage[]) {
  return messages
    .map((message, index) => ({ index, message }))
    .sort(
      (left, right) =>
        left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index,
    )
    .map(({ message }) => message);
}

function isDuplicateOptimisticQueuedMessage(
  previous: ChatMessage | undefined,
  incoming: ChatMessage,
) {
  return (
    previous !== undefined &&
    isOptimisticUserMessage(previous) &&
    previous.threadId === incoming.threadId &&
    previous.role === incoming.role &&
    previous.content === incoming.content
  );
}

function replacementMessageId(message: ChatMessage) {
  const replacementId = message.details?.replacesMessageId;
  return typeof replacementId === "string" && replacementId.length > 0 ? replacementId : undefined;
}
