import type { ChatMessage } from "@aias00/codex-relay/api-schema";

export type TimelinePlanProgressStepStatus = "completed" | "inProgress" | "pending";

export type TimelinePlanProgressStep = {
  readonly id: string;
  readonly status: TimelinePlanProgressStepStatus;
  readonly text: string;
};

export type TimelinePlanProgress = {
  readonly messageId: string;
  readonly steps: readonly TimelinePlanProgressStep[];
};

export type TimelineSubagentStatus = "running" | "completed" | "interrupted" | "failed";

export type TimelineSubagent = {
  readonly id: string;
  readonly label: string;
  readonly status: TimelineSubagentStatus;
};

export type TimelineSubagentSummary = {
  readonly agents: readonly TimelineSubagent[];
};

const MAX_SUMMARIZED_SUBAGENTS = 64;

export function splitTimelinePlanProgress(messages: readonly ChatMessage[], isRunning: boolean) {
  let progress: TimelinePlanProgress | undefined;
  let progressMessage: ChatMessage | undefined;
  let progressMessageIndex = -1;

  for (const [index, message] of messages.entries()) {
    if (isTimelinePlanProgressMessage(message) && isRunning) {
      progress = planProgressFromMessage(message);
      progressMessage = message;
      progressMessageIndex = index;
    }
  }

  const latestUserIndex = latestUserMessageIndex(messages, messages.length - 1);
  if (progressMessageIndex >= 0 && latestUserIndex > progressMessageIndex) {
    progress = undefined;
    progressMessage = undefined;
    progressMessageIndex = -1;
  }

  const turnStartIndex = progressMessage
    ? latestUserMessageIndex(messages, progressMessageIndex)
    : -1;
  const turnEndIndex = progressMessage
    ? nextUserMessageIndex(messages, progressMessageIndex)
    : messages.length;
  const planTurnId = progressMessage?.turnId ?? messages[turnStartIndex]?.turnId;
  const subagentMap = new Map<string, TimelineSubagent>();
  const summarizedSubagentMessageIds = new Set<string>();

  if (progress && progressMessage) {
    for (const [index, message] of messages.entries()) {
      if (
        message.kind === "subagentAction" &&
        isMessageInPlanTurn(message, index, planTurnId, turnStartIndex, turnEndIndex)
      ) {
        if (foldSubagentMessage(subagentMap, message)) {
          summarizedSubagentMessageIds.add(message.id);
        }
      }
    }
  }

  const subagents = subagentMap.size > 0 ? { agents: [...subagentMap.values()] } : undefined;
  const visibleMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (isTimelinePlanProgressMessage(message)) {
      continue;
    }

    if (message.kind === "subagentAction" && summarizedSubagentMessageIds.has(message.id)) {
      continue;
    }

    visibleMessages.push(message);
  }

  return {
    progress,
    subagents,
    visibleMessages,
  };
}

export function isTimelinePlanProgressMessage(message: ChatMessage) {
  return message.kind === "plan" && message.role === "status";
}

export function activePlanProgressStep(progress: TimelinePlanProgress) {
  return (
    progress.steps.find((step) => step.status === "inProgress") ??
    progress.steps.find((step) => step.status === "pending") ??
    progress.steps[progress.steps.length - 1]
  );
}

export function implementablePlanId(messages: readonly ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (isImplementablePlanMessage(message)) {
      return message.id;
    }
    if (!isResolvedInputRequest(message)) {
      return undefined;
    }
  }
  return undefined;
}

function isImplementablePlanMessage(message: ChatMessage) {
  return (
    message.kind === "plan" &&
    message.role === "assistant" &&
    message.state !== "streaming" &&
    Boolean(message.content.trim())
  );
}

function isResolvedInputRequest(message: ChatMessage) {
  if (message.kind !== "structuredUserInput") {
    return false;
  }
  return (
    message.details?.approvalResolved === true ||
    typeof message.details?.approvalDecision === "string"
  );
}

function planProgressFromMessage(message: ChatMessage): TimelinePlanProgress | undefined {
  const steps = [
    ...planProgressStepsFromUnknown(message.details?.plan),
    ...planProgressStepsFromUnknown(message.details?.steps),
  ];
  const parsedSteps = steps.length > 0 ? steps : planProgressStepsFromContent(message.content);

  if (parsedSteps.length === 0) {
    return undefined;
  }

  return {
    messageId: message.id,
    steps: parsedSteps.map((step, index) => ({
      ...step,
      id: `${message.id}-${index}`,
    })),
  };
}

function planProgressStepsFromUnknown(
  value: unknown,
): readonly Omit<TimelinePlanProgressStep, "id">[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      const text = item.trim();
      return text ? [{ status: "pending", text }] : [];
    }

    const text = stringRecordValue(item, "step") ?? stringRecordValue(item, "text");
    const status = normalizeStepStatus(stringRecordValue(item, "status"));
    if (!text || !status) {
      return [];
    }

    return [{ status, text }];
  });
}

function planProgressStepsFromContent(
  content: string,
): readonly Omit<TimelinePlanProgressStep, "id">[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(completed|inProgress|in_progress|pending)\s*:\s*(.+?)\s*$/i);
      const status = normalizeStepStatus(match?.[1]);
      const text = match?.[2]?.trim();
      return status && text ? [{ status, text }] : [];
    });
}

function normalizeStepStatus(
  value: string | undefined,
): TimelinePlanProgressStepStatus | undefined {
  const normalized = value?.trim().replace(/[- ]/g, "_");

  switch (normalized) {
    case "completed":
      return "completed";
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "pending":
      return "pending";
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function stringRecordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string") {
      return entryValue.trim() || undefined;
    }
  }

  return undefined;
}

function latestUserMessageIndex(messages: readonly ChatMessage[], beforeIndex: number) {
  for (let index = beforeIndex; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return 0;
}

function nextUserMessageIndex(messages: readonly ChatMessage[], afterIndex: number) {
  for (let index = afterIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return messages.length;
}

function isMessageInPlanTurn(
  message: ChatMessage,
  messageIndex: number,
  planTurnId: string | undefined,
  turnStartIndex: number,
  turnEndIndex: number,
) {
  if (message.turnId || planTurnId) {
    return message.turnId === planTurnId;
  }

  return messageIndex >= turnStartIndex && messageIndex < turnEndIndex;
}

function foldSubagentMessage(subagents: Map<string, TimelineSubagent>, message: ChatMessage) {
  const detailsType = stringRecordValue(message.details, "type");

  if (detailsType === "subAgentActivity") {
    const activityKind = stringRecordValue(message.details, "activityKind");
    if (
      activityKind !== "started" &&
      activityKind !== "interacted" &&
      activityKind !== "interrupted"
    ) {
      return false;
    }

    const agentThreadId = stringRecordValue(message.details, "agentThreadId");
    if (!agentThreadId) {
      return false;
    }

    const agentPath = stringRecordValue(message.details, "agentPath");
    const current = subagents.get(agentThreadId);
    const nextStatus = activityKind === "interrupted" ? "interrupted" : "running";
    return upsertSubagent(subagents, agentThreadId, {
      label: agentPath,
      status:
        current && current.status !== "running" && nextStatus === "running"
          ? current.status
          : nextStatus,
    });
  }

  if (detailsType !== "collabAgentToolCall") {
    return false;
  }

  const tool = stringRecordValue(message.details, "tool");
  const callStatus = stringRecordValue(message.details, "status");
  if (!isCollabTool(tool) || !isCollabCallStatus(callStatus)) {
    return false;
  }

  const receiverThreadIds = stringArrayRecordValue(message.details, "receiverThreadIds");
  if (!receiverThreadIds || receiverThreadIds.length === 0) {
    return false;
  }

  const newAgentCount = new Set(
    receiverThreadIds.filter((receiverThreadId) => !subagents.has(receiverThreadId)),
  ).size;
  if (subagents.size + newAgentCount > MAX_SUMMARIZED_SUBAGENTS) {
    return false;
  }

  const agentStates = recordValue(message.details, "agentsStates");
  for (const receiverThreadId of receiverThreadIds) {
    const agentState = recordValue(agentStates, receiverThreadId);
    const reportedStatus = normalizeSubagentStatus(stringRecordValue(agentState, "status"));
    const fallbackStatus =
      callStatus === "failed"
        ? "failed"
        : tool === "closeAgent" && callStatus === "completed"
          ? "completed"
          : "running";
    upsertSubagent(subagents, receiverThreadId, {
      status: reportedStatus ?? fallbackStatus,
    });
  }

  return true;
}

function isCollabTool(value: string | undefined) {
  return (
    value === "spawnAgent" ||
    value === "sendInput" ||
    value === "resumeAgent" ||
    value === "wait" ||
    value === "closeAgent"
  );
}

function isCollabCallStatus(value: string | undefined) {
  return value === "inProgress" || value === "completed" || value === "failed";
}

function upsertSubagent(
  subagents: Map<string, TimelineSubagent>,
  id: string,
  next: { readonly label?: string; readonly status: TimelineSubagentStatus },
) {
  const current = subagents.get(id);
  if (!current && subagents.size >= MAX_SUMMARIZED_SUBAGENTS) {
    return false;
  }

  subagents.set(id, {
    id,
    label: next.label ?? current?.label ?? `Subagent ${subagents.size + 1}`,
    status: next.status,
  });
  return true;
}

function normalizeSubagentStatus(value: string | undefined): TimelineSubagentStatus | undefined {
  switch (value?.trim().toLowerCase()) {
    case "pendinginit":
    case "pending_init":
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "completed";
    case "interrupted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    case "errored":
    case "failed":
    case "notfound":
    case "not_found":
      return "failed";
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function stringArrayRecordValue(value: unknown, key: string) {
  const entry = recordValue(value, key);
  if (!Array.isArray(entry) || entry.length > MAX_SUMMARIZED_SUBAGENTS) {
    return undefined;
  }

  return entry.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
