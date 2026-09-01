import { batch, observable } from "@legendapp/state";
import type {
  AgentSkill,
  ChatMessage,
  CodexModel,
  ContextWindowUsage,
  QueuedThreadInput,
  RateLimitBucket,
  ReasoningEffort,
  RuntimePreferences,
  RuntimeMode,
  StreamThreadRunEvent,
  ThreadCollaborationMode,
  ThreadSummary,
} from "@aias00/codex-relay/api-schema";

import {
  cacheChatNavigation,
  cachedChatNavigationForRelay,
  clearCachedChatNavigation,
  readCachedChatNavigation,
} from "../lib/chat-navigation-cache";
import { getStoredConnectionPlan } from "../lib/codex-relay-connection-plan";
import {
  initializeThreadSeenBaselineState,
  isThreadCompletionUnseen,
  markThreadSeenState,
  persistThreadSeenState,
  readThreadSeenState,
  type ThreadSeenState,
} from "../lib/thread-seen-store";
import { resetWorkspacePreviewState } from "./workspace-preview-store";

type ConnectionState = "checking" | "connected" | "offline";
export type ThreadSyncState = "cached" | "syncing" | "hydrating-history" | "synced" | "stale";

export type ComposerAttachment = {
  id: string;
  name?: string;
  uri: string;
};

export type LocalPromptAttachment = ComposerAttachment & {
  mimeType?: string;
  name?: string;
  path: string;
  url?: string;
};

export type QueuedComposerPrompt = QueuedThreadInput;

type ChatState = {
  activeThreadId?: string;
  composerAttachmentsByThreadId: Record<string, LocalPromptAttachment[]>;
  composerDraftByThreadId: Record<string, string>;
  composerSkillsByThreadId: Record<string, AgentSkill[]>;
  collaborationModeByThreadId: Record<string, ThreadCollaborationMode>;
  queuedPromptsByThreadId: Record<string, QueuedComposerPrompt[]>;
  connection: ConnectionState;
  error?: string;
  hasPairedSession: boolean;
  threadMessagesLoadingByThreadId: Record<string, boolean>;
  threadSeenState: ThreadSeenState;
  threadSyncStateByThreadId: Record<string, ThreadSyncState>;
  threadStreamReconnectRequest?: {
    requestId: number;
    threadId: string;
  };
  machineName?: string;
  contextUsageByThreadId: Record<string, ContextWindowUsage>;
  messagesByThreadId: Record<string, ChatMessage[]>;
  models: CodexModel[];
  rateLimitBuckets: RateLimitBucket[];
  runtimeMode: RuntimeMode;
  runtimePreferencesByWorkspacePath: Record<string, RuntimePreferences>;
  selectedReasoningEffort?: ReasoningEffort;
  selectedModel?: string;
  serverUrl: string;
  threadIds: string[];
  threadsById: Record<string, ThreadSummary>;
  workspaceId?: string;
  workspacePath?: string;
};

const cachedChatNavigation = cachedChatNavigationForRelay(
  readCachedChatNavigation(),
  getStoredConnectionPlan()?.relayId,
);

export const chatStore$ = observable<ChatState>({
  activeThreadId: cachedChatNavigation.activeThreadId,
  composerAttachmentsByThreadId: {},
  composerDraftByThreadId: {},
  composerSkillsByThreadId: {},
  collaborationModeByThreadId: {},
  queuedPromptsByThreadId: {},
  connection: "checking",
  error: undefined,
  hasPairedSession: false,
  threadMessagesLoadingByThreadId: {},
  threadSeenState: readThreadSeenState(),
  threadSyncStateByThreadId: {},
  threadStreamReconnectRequest: undefined,
  machineName: undefined,
  contextUsageByThreadId: {},
  messagesByThreadId: {},
  models: [],
  rateLimitBuckets: [],
  runtimeMode: "default",
  runtimePreferencesByWorkspacePath: {},
  selectedReasoningEffort: undefined,
  selectedModel: undefined,
  serverUrl: "",
  threadIds: [],
  threadsById: {},
  workspaceId: cachedChatNavigation.workspaceId,
  workspacePath: cachedChatNavigation.workspacePath,
});

export function setConnection(connection: ConnectionState, error?: string) {
  if (chatStore$.connection.peek() === connection && chatStore$.error.peek() === error) {
    return;
  }
  chatStore$.connection.set(connection);
  chatStore$.error.set(error);
}

const NEW_THREAD_COMPOSER_KEY = "__new_thread__";

export function composerThreadKey(threadId: string | undefined) {
  return threadId ?? NEW_THREAD_COMPOSER_KEY;
}

export function activeComposerThreadKey() {
  return composerThreadKey(chatStore$.activeThreadId.peek());
}

export function getComposerDraft(threadId = chatStore$.activeThreadId.peek()) {
  return chatStore$.composerDraftByThreadId[composerThreadKey(threadId)].peek() ?? "";
}

export function getComposerAttachments(threadId = chatStore$.activeThreadId.peek()) {
  return chatStore$.composerAttachmentsByThreadId[composerThreadKey(threadId)].peek() ?? [];
}

export function getComposerSkills(threadId = chatStore$.activeThreadId.peek()) {
  return chatStore$.composerSkillsByThreadId[composerThreadKey(threadId)].peek() ?? [];
}

export function getCollaborationMode(threadId = chatStore$.activeThreadId.peek()) {
  return (
    chatStore$.collaborationModeByThreadId[composerThreadKey(threadId)].peek() ??
    (threadId ? chatStore$.threadsById[threadId].peek()?.collaborationMode : undefined) ??
    "default"
  );
}

export function setComposerDraft(draft: string, threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerDraftByThreadId.set((current) => {
    if (!draft) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: draft };
  });
}

export function clearComposerDraft(threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerDraftByThreadId.set((current) => {
    const { [key]: _removed, ...rest } = current;
    return rest;
  });
  chatStore$.composerAttachmentsByThreadId.set((current) => {
    const { [key]: _removed, ...rest } = current;
    return rest;
  });
  chatStore$.composerSkillsByThreadId.set((current) => {
    const { [key]: _removed, ...rest } = current;
    return rest;
  });
}

export function setComposerAttachments(attachments: LocalPromptAttachment[], threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerAttachmentsByThreadId.set((current) => {
    if (attachments.length === 0) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: attachments };
  });
}

export function appendComposerAttachments(attachments: LocalPromptAttachment[], threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerAttachmentsByThreadId.set((current) => ({
    ...current,
    [key]: [...(current[key] ?? []), ...attachments],
  }));
}

export function removeComposerAttachment(id: string, threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerAttachmentsByThreadId.set((current) => {
    const nextAttachments = (current[key] ?? []).filter((attachment) => attachment.id !== id);
    if (nextAttachments.length === 0) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: nextAttachments };
  });
}

export function setComposerSkills(skills: AgentSkill[], threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerSkillsByThreadId.set((current) => {
    if (skills.length === 0) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: skills };
  });
}

export function appendComposerSkill(skill: AgentSkill, threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerSkillsByThreadId.set((current) => {
    const skills = current[key] ?? [];
    if (skills.some((item) => item.id === skill.id || item.name === skill.name)) {
      return current;
    }
    return { ...current, [key]: [...skills, skill] };
  });
}

export function removeComposerSkill(id: string, threadId?: string) {
  const key = composerThreadKey(threadId ?? chatStore$.activeThreadId.peek());
  chatStore$.composerSkillsByThreadId.set((current) => {
    const nextSkills = (current[key] ?? []).filter((skill) => skill.id !== id);
    if (nextSkills.length === 0) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: nextSkills };
  });
}

export function setQueuedPrompts(threadId: string, prompts: QueuedComposerPrompt[]) {
  chatStore$.queuedPromptsByThreadId.set((current) => ({ ...current, [threadId]: prompts }));
}

export function clearQueuedPrompts(threadId: string | undefined) {
  if (!threadId) {
    return;
  }
  chatStore$.queuedPromptsByThreadId.set((current) => {
    const { [threadId]: _removed, ...rest } = current;
    return rest;
  });
}

export function removeQueuedPrompt(threadId: string, id: string) {
  chatStore$.queuedPromptsByThreadId[threadId].set((current = []) =>
    current.filter((prompt) => prompt.id !== id),
  );
}

export function setHasPairedSession(hasPairedSession: boolean) {
  if (chatStore$.hasPairedSession.peek() === hasPairedSession) {
    return;
  }
  chatStore$.hasPairedSession.set(hasPairedSession);
}

export function setWorkspacePath(workspacePath: string | undefined) {
  chatStore$.workspacePath.set(workspacePath);
  persistChatNavigation();
}

export function setWorkspaceSelection(selection: { workspaceId?: string; workspacePath?: string }) {
  batch(() => {
    chatStore$.workspaceId.set(selection.workspaceId);
    chatStore$.workspacePath.set(selection.workspacePath);
  });
  persistChatNavigation();
}

export function activateWorkspaceThread(
  threadId: string,
  selection: { workspaceId?: string; workspacePath?: string },
) {
  batch(() => {
    chatStore$.workspaceId.set(selection.workspaceId);
    chatStore$.workspacePath.set(selection.workspacePath);
    chatStore$.activeThreadId.set(threadId);
  });
  markKnownThreadSeen(threadId);
  persistChatNavigation();
}

export function setMachineName(machineName: string | undefined) {
  chatStore$.machineName.set(machineName);
}

export function setServerUrl(serverUrl: string) {
  if (chatStore$.serverUrl.peek() === serverUrl) {
    return;
  }
  chatStore$.serverUrl.set(serverUrl);
}

export function setRunning(isRunning: boolean) {
  const activeThreadId = chatStore$.activeThreadId.peek();
  setThreadRunningState(activeThreadId, isRunning);
}

export function stopThreadLocally(threadId: string | undefined) {
  setThreadRunningState(threadId, false);
}

function setThreadRunningState(threadId: string | undefined, isRunning: boolean) {
  if (!threadId) {
    return;
  }
  chatStore$.threadsById[threadId].set((thread) =>
    thread
      ? {
          ...thread,
          state: isRunning ? "running" : "completed",
          updatedAt: new Date().toISOString(),
        }
      : thread,
  );
}

export function requestThreadStreamReconnect(threadId: string) {
  const current = chatStore$.threadStreamReconnectRequest.peek();
  chatStore$.threadStreamReconnectRequest.set({
    requestId: (current?.requestId ?? 0) + 1,
    threadId,
  });
}

export function clearThreadStreamReconnectRequest(requestId: number) {
  const current = chatStore$.threadStreamReconnectRequest.peek();
  if (current?.requestId === requestId) {
    chatStore$.threadStreamReconnectRequest.set(undefined);
  }
}

export function setThreadMessagesLoading(threadId: string | undefined, isLoading: boolean) {
  if (!threadId) {
    return;
  }
  chatStore$.threadMessagesLoadingByThreadId.set((current) => {
    if (!isLoading) {
      if (!current[threadId]) {
        return current;
      }
      const { [threadId]: _removed, ...rest } = current;
      return rest;
    }
    if (current[threadId]) {
      return current;
    }
    return { ...current, [threadId]: true };
  });
}

export function setThreadSyncState(threadId: string | undefined, state: ThreadSyncState) {
  if (!threadId) {
    return;
  }
  chatStore$.threadSyncStateByThreadId.set((current) =>
    current[threadId] === state ? current : { ...current, [threadId]: state },
  );
}

export function setModels(models: CodexModel[]) {
  chatStore$.models.set(models);
  const selectedModel = chatStore$.selectedModel.peek();
  const nextSelectedModel = models.some((model) => model.model === selectedModel)
    ? selectedModel
    : (models.find((model) => model.isDefault)?.model ?? models[0]?.model);
  chatStore$.selectedModel.set(nextSelectedModel);
  setReasoningForModel(nextSelectedModel, chatStore$.selectedReasoningEffort.peek(), models);
}

export function setRateLimitBuckets(rateLimitBuckets: RateLimitBucket[]) {
  chatStore$.rateLimitBuckets.set(rateLimitBuckets);
}

export function setCollaborationMode(collaborationMode: ThreadCollaborationMode) {
  setThreadCollaborationMode(chatStore$.activeThreadId.peek(), collaborationMode);
}

export function setThreadCollaborationMode(
  threadId: string | undefined,
  collaborationMode: ThreadCollaborationMode,
) {
  const key = composerThreadKey(threadId);
  chatStore$.collaborationModeByThreadId.set((current) => {
    if (collaborationMode === "default") {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [key]: collaborationMode };
  });
}

export function moveNewThreadCollaborationMode(
  threadId: string,
  collaborationMode = chatStore$.collaborationModeByThreadId[NEW_THREAD_COMPOSER_KEY].peek() ??
    "default",
) {
  chatStore$.collaborationModeByThreadId.set((current) => {
    const { [NEW_THREAD_COMPOSER_KEY]: _removed, ...rest } = current;
    if (collaborationMode === "default") {
      return rest;
    }
    return { ...rest, [threadId]: collaborationMode };
  });
}

export function setContextWindowUsage(threadId: string, usage: ContextWindowUsage | undefined) {
  chatStore$.contextUsageByThreadId.set((current) => {
    if (!usage) {
      const { [threadId]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [threadId]: usage };
  });
}

export function setSelectedModel(model: string | undefined) {
  chatStore$.selectedModel.set(model);
  setReasoningForModel(model, chatStore$.selectedReasoningEffort.peek(), chatStore$.models.peek());
}

export function setSelectedReasoningEffort(reasoningEffort: ReasoningEffort | undefined) {
  const selectedModel = chatStore$.selectedModel.peek();
  const model = chatStore$.models.peek().find((candidate) => candidate.model === selectedModel);
  if (!reasoningEffort || model?.supportedReasoningEfforts.includes(reasoningEffort)) {
    chatStore$.selectedReasoningEffort.set(reasoningEffort);
  }
}

export function setRuntimeMode(runtimeMode: RuntimeMode) {
  chatStore$.runtimeMode.set(runtimeMode);
}

export function setRuntimePreferences(preferences: RuntimePreferences) {
  chatStore$.runtimeMode.set(preferences.runtimeMode);
  chatStore$.selectedModel.set(preferences.model);
  chatStore$.selectedReasoningEffort.set(preferences.reasoningEffort);
  const models = chatStore$.models.peek();
  if (models.length > 0) {
    setReasoningForModel(preferences.model, preferences.reasoningEffort, models);
  }
}

export function setWorkspaceRuntimePreferences(
  workspacePath: string | undefined,
  preferences: RuntimePreferences,
) {
  if (!workspacePath) {
    setRuntimePreferences(preferences);
    return;
  }
  chatStore$.runtimePreferencesByWorkspacePath.set((current) => ({
    ...current,
    [workspacePath]: preferences,
  }));
}

export function replaceWorkspaceRuntimePreferences(
  preferencesByWorkspacePath: Record<string, RuntimePreferences>,
) {
  chatStore$.runtimePreferencesByWorkspacePath.set(preferencesByWorkspacePath);
}

export function setActiveThread(threadId: string | undefined) {
  chatStore$.activeThreadId.set(threadId);
  markKnownThreadSeen(threadId);
  persistChatNavigation();
}

export function activateThreadSnapshot(thread: ThreadSummary, messages?: ChatMessage[]) {
  upsertThread(thread);
  if (messages) {
    replaceMessages(thread.id, messages);
  }
  setActiveThread(thread.id);
}

export function resetChatSessionState() {
  chatStore$.activeThreadId.set(undefined);
  chatStore$.composerAttachmentsByThreadId.set({});
  chatStore$.composerDraftByThreadId.set({});
  chatStore$.composerSkillsByThreadId.set({});
  chatStore$.collaborationModeByThreadId.set({});
  chatStore$.queuedPromptsByThreadId.set({});
  chatStore$.connection.set("offline");
  chatStore$.error.set("Pair with your computer to continue.");
  chatStore$.hasPairedSession.set(false);
  chatStore$.threadMessagesLoadingByThreadId.set({});
  chatStore$.threadSyncStateByThreadId.set({});
  chatStore$.threadStreamReconnectRequest.set(undefined);
  chatStore$.contextUsageByThreadId.set({});
  chatStore$.messagesByThreadId.set({});
  chatStore$.models.set([]);
  chatStore$.rateLimitBuckets.set([]);
  chatStore$.runtimePreferencesByWorkspacePath.set({});
  resetWorkspacePreviewState();
  chatStore$.machineName.set(undefined);
  chatStore$.selectedReasoningEffort.set(undefined);
  chatStore$.selectedModel.set(undefined);
  chatStore$.threadIds.set([]);
  chatStore$.threadsById.set({});
  chatStore$.workspaceId.set(undefined);
  chatStore$.workspacePath.set(undefined);
  clearCachedChatNavigation();
}

export function replaceThreads(threads: ThreadSummary[]) {
  initializeThreadSeenBaseline(threads);
  const threadsById: Record<string, ThreadSummary> = {};
  for (const thread of threads) {
    threadsById[thread.id] = thread;
  }

  chatStore$.threadsById.set(threadsById);
  chatStore$.threadIds.set(sortThreadIds(threads));
  const activeThreadId = chatStore$.activeThreadId.get();
  if (!activeThreadId || !threadsById[activeThreadId]) {
    const nextActiveThreadId = threads[0]?.id;
    setActiveThread(nextActiveThreadId);
    return;
  }
  markThreadSeen(threadsById[activeThreadId]);
}

export function initializeThreadSeenBaseline(threads: ThreadSummary[]) {
  updateThreadSeenState((current) =>
    initializeThreadSeenBaselineState(current, currentThreadSeenRelayId(), threads),
  );
}

export function markThreadSeen(thread: ThreadSummary | undefined) {
  if (!thread) {
    return;
  }
  updateThreadSeenState((current) =>
    markThreadSeenState(current, currentThreadSeenRelayId(), thread),
  );
}

export function markThreadSeenIfActive(thread: ThreadSummary) {
  if (chatStore$.activeThreadId.peek() === thread.id) {
    markThreadSeen(thread);
  }
}

export function threadHasUnseenCompletion(
  thread: ThreadSummary,
  state = chatStore$.threadSeenState.peek(),
) {
  return isThreadCompletionUnseen(state, currentThreadSeenRelayId(), thread);
}

function persistChatNavigation() {
  cacheChatNavigation({
    activeThreadId: chatStore$.activeThreadId.peek(),
    relayId: getStoredConnectionPlan()?.relayId,
    workspaceId: chatStore$.workspaceId.peek(),
    workspacePath: chatStore$.workspacePath.peek(),
  });
}

export function upsertThread(thread: ThreadSummary) {
  chatStore$.threadsById.set((current) => ({ ...current, [thread.id]: thread }));
  chatStore$.threadIds.set((current) => {
    const next = current.includes(thread.id)
      ? current
      : [thread.id, ...current.filter((id) => chatStore$.threadsById[id].peek())];
    return sortThreadIds(
      next.flatMap((id) => {
        const knownThread = id === thread.id ? thread : chatStore$.threadsById[id].peek();
        return knownThread ? [knownThread] : [];
      }),
    );
  });
  markThreadSeenIfActive(thread);
}

function markKnownThreadSeen(threadId: string | undefined) {
  const thread = threadId ? chatStore$.threadsById[threadId].peek() : undefined;
  if (thread) {
    markThreadSeen(thread);
  }
}

function currentThreadSeenRelayId() {
  return getStoredConnectionPlan()?.relayId ?? "legacy";
}

function updateThreadSeenState(update: (state: ThreadSeenState) => ThreadSeenState) {
  const current = chatStore$.threadSeenState.peek();
  const next = update(current);
  if (next === current) {
    return;
  }
  chatStore$.threadSeenState.set(next);
  persistThreadSeenState(next);
}

export function mergeActiveThreadInto(thread: ThreadSummary) {
  const activeThreadId = chatStore$.activeThreadId.peek();
  if (!activeThreadId || activeThreadId === thread.id) {
    return;
  }

  const activeMessages = chatStore$.messagesByThreadId[activeThreadId].peek() ?? [];
  if (activeMessages.length === 0) {
    return;
  }

  const targetMessages = chatStore$.messagesByThreadId[thread.id].peek() ?? [];
  const targetIds = new Set(targetMessages.map((message) => message.id));
  const migratedMessages = activeMessages.reduce<ChatMessage[]>((messages, message) => {
    if (!targetIds.has(message.id)) {
      messages.push({ ...message, threadId: thread.id });
    }
    return messages;
  }, []);

  chatStore$.messagesByThreadId.set((current) => {
    const { [activeThreadId]: _removed, ...rest } = current;
    return {
      ...rest,
      [thread.id]: [...migratedMessages, ...targetMessages],
    };
  });
  moveThreadScopedState(activeThreadId, thread.id);
  chatStore$.threadsById.set((current) => {
    const { [activeThreadId]: _removed, ...rest } = current;
    return rest;
  });
  chatStore$.threadIds.set((current) => current.filter((id) => id !== activeThreadId));
}

export function replaceMessages(threadId: string, messages: ChatMessage[]) {
  chatStore$.messagesByThreadId.set((current) => ({ ...current, [threadId]: messages }));
}

export function upsertMessage(message: ChatMessage) {
  chatStore$.messagesByThreadId.set((current) => {
    const messages = current[message.threadId] ?? [];
    const existingIndex = messages.findIndex((item) => item.id === message.id);
    const nextMessages =
      existingIndex === -1
        ? upsertNewMessage(messages, message)
        : messages.map((item) => (item.id === message.id ? message : item));

    return { ...current, [message.threadId]: nextMessages };
  });
}

function upsertNewMessage(messages: ChatMessage[], message: ChatMessage) {
  const replacementId = replacementMessageId(message);
  const replacementIndex = replacementId
    ? messages.findIndex((item) => item.id === replacementId)
    : -1;
  if (replacementIndex !== -1) {
    return messages.map((item, index) => (index === replacementIndex ? message : item));
  }
  return [...messages, message];
}

function replacementMessageId(message: ChatMessage) {
  const replacementId = message.details?.replacesMessageId;
  return typeof replacementId === "string" && replacementId.length > 0 ? replacementId : undefined;
}

export function markMessageApprovalResolved(threadId: string, messageId: string, decision: string) {
  chatStore$.messagesByThreadId.set((current) => {
    const messages = current[threadId] ?? [];
    return {
      ...current,
      [threadId]: messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              details: {
                ...message.details,
                approvalDecision: decision,
                approvalResolved: true,
              },
              updatedAt: new Date().toISOString(),
            }
          : message,
      ),
    };
  });
}

export function appendMessageDelta(threadId: string, messageId: string, delta: string) {
  chatStore$.messagesByThreadId.set((current) => {
    const messages = current[threadId] ?? [];
    return {
      ...current,
      [threadId]: messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: `${message.content}${normalizeStreamDelta(message.content, delta)}`,
              state: "streaming",
              updatedAt: new Date().toISOString(),
            }
          : message,
      ),
    };
  });
}

function normalizeStreamDelta(existingContent: string, incomingDelta: string) {
  if (!existingContent || !incomingDelta.startsWith(existingContent)) {
    return incomingDelta;
  }
  return incomingDelta.slice(existingContent.length);
}

export function applyStreamEvent(
  event: StreamThreadRunEvent,
  options: { sourceThreadId?: string } = {},
) {
  const canUpdateActiveThread = shouldStreamEventUpdateActiveThread(options.sourceThreadId);

  switch (event.type) {
    case "thread.message.created":
      if (canUpdateActiveThread) {
        mergeActiveThreadInto(event.thread);
      }
      upsertThread(event.thread);
      upsertMessage(event.message);
      if (canUpdateActiveThread) {
        setActiveThread(event.thread.id);
      }
      return;
    case "thread.message.delta":
      appendMessageDelta(event.threadId, event.messageId, event.delta);
      return;
    case "thread.message.completed":
      if (canUpdateActiveThread) {
        mergeActiveThreadInto(event.thread);
      }
      upsertThread(event.thread);
      upsertMessage(event.message);
      if (canUpdateActiveThread) {
        setRunning(event.thread.state === "running");
      }
      return;
    case "thread.state.changed":
      if (canUpdateActiveThread) {
        mergeActiveThreadInto(event.thread);
      }
      upsertThread(event.thread);
      if (canUpdateActiveThread) {
        setRunning(event.thread.state === "running");
      }
      return;
    case "thread.error":
      if (event.thread) {
        if (canUpdateActiveThread) {
          mergeActiveThreadInto(event.thread);
        }
        upsertThread(event.thread);
      }
      chatStore$.error.set(event.error.message);
      if (canUpdateActiveThread) {
        setRunning(false);
      }
      return;
    case "thread.preview_target.detected":
      return;
  }
}

function shouldStreamEventUpdateActiveThread(sourceThreadId: string | undefined) {
  if (!sourceThreadId) {
    return true;
  }
  const activeThreadId = chatStore$.activeThreadId.peek();
  return !activeThreadId || activeThreadId === sourceThreadId;
}

function moveThreadScopedState(sourceThreadId: string, targetThreadId: string) {
  moveRecordValue(chatStore$.composerAttachmentsByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.composerDraftByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.composerSkillsByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.collaborationModeByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.contextUsageByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.queuedPromptsByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.threadMessagesLoadingByThreadId, sourceThreadId, targetThreadId);
  moveRecordValue(chatStore$.threadSyncStateByThreadId, sourceThreadId, targetThreadId);
}

function moveRecordValue<T>(
  record$: {
    set: (updater: (current: Record<string, T>) => Record<string, T>) => void;
  },
  sourceKey: string,
  targetKey: string,
) {
  record$.set((current) => {
    if (!(sourceKey in current)) {
      return current;
    }
    const { [sourceKey]: value, ...rest } = current;
    return { ...rest, [targetKey]: value };
  });
}

function sortThreadIds(threads: ThreadSummary[]) {
  return threads
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((thread) => thread.id);
}

function setReasoningForModel(
  selectedModel: string | undefined,
  currentReasoningEffort: ReasoningEffort | undefined,
  models: CodexModel[],
) {
  const model = models.find((candidate) => candidate.model === selectedModel);
  const supported = model?.supportedReasoningEfforts ?? [];
  if (supported.length === 0) {
    chatStore$.selectedReasoningEffort.set(undefined);
    return;
  }

  if (currentReasoningEffort && supported.includes(currentReasoningEffort)) {
    chatStore$.selectedReasoningEffort.set(currentReasoningEffort);
    return;
  }

  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    chatStore$.selectedReasoningEffort.set(model.defaultReasoningEffort);
    return;
  }

  chatStore$.selectedReasoningEffort.set(supported.includes("medium") ? "medium" : supported[0]);
}
