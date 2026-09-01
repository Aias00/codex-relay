import {
  WORKSPACE_PREVIEW_TAB_VALUES,
  type WorkspacePreviewTab,
} from "@aias00/codex-relay/api-schema";
import { observable } from "@legendapp/state";

import { persistLocalObservable } from "./persistence";

export { type WorkspacePreviewTab };

export const WORKSPACE_PREVIEW_TABS = WORKSPACE_PREVIEW_TAB_VALUES;

export const DEFAULT_WORKSPACE_PREVIEW_TABS = WORKSPACE_PREVIEW_TAB_VALUES;

export type WorkspacePreviewWebState = {
  draft?: string;
  isUserControlled?: boolean;
  url?: string;
};

type WorkspacePreviewState = {
  activeTabByWorkspacePath: Record<string, WorkspacePreviewTab>;
  tabsByWorkspacePath: Record<string, WorkspacePreviewTab[]>;
  webStateByWorkspacePath: Record<string, WorkspacePreviewWebState>;
};

export const workspacePreviewStore$ = observable<WorkspacePreviewState>(
  createDefaultWorkspacePreviewState(),
);

persistLocalObservable(workspacePreviewStore$, "workspace-preview");

export function workspacePreviewKey(workspacePath: string | undefined) {
  return workspacePath?.trim() || "__default_workspace__";
}

export function getWorkspacePreviewTabs(workspacePath: string | undefined) {
  const key = workspacePreviewKey(workspacePath);
  return workspacePreviewStore$.tabsByWorkspacePath[key].peek() ?? DEFAULT_WORKSPACE_PREVIEW_TABS;
}

export function addWorkspacePreviewTab(
  workspacePath: string | undefined,
  tab: WorkspacePreviewTab,
  options: { activate?: boolean } = {},
) {
  const key = workspacePreviewKey(workspacePath);
  workspacePreviewStore$.tabsByWorkspacePath.set((current) => {
    const currentTabs = current[key] ?? DEFAULT_WORKSPACE_PREVIEW_TABS;
    return {
      ...current,
      [key]: currentTabs.includes(tab) ? currentTabs : [...currentTabs, tab],
    };
  });
  if (options.activate ?? true) {
    setActiveWorkspacePreviewTab(workspacePath, tab);
  }
}

export function removeWorkspacePreviewTab(
  workspacePath: string | undefined,
  tab: WorkspacePreviewTab,
) {
  const key = workspacePreviewKey(workspacePath);
  workspacePreviewStore$.set((current) => {
    const currentTabs = current.tabsByWorkspacePath[key] ?? DEFAULT_WORKSPACE_PREVIEW_TABS;
    if (!currentTabs.includes(tab)) {
      return current;
    }

    const nextTabs = currentTabs.filter((candidate) => candidate !== tab);
    const nextActiveTab = nextTabs[0];
    const nextTabsByWorkspacePath = {
      ...current.tabsByWorkspacePath,
      [key]: nextTabs,
    };
    let nextActiveTabByWorkspacePath = current.activeTabByWorkspacePath;

    if (current.activeTabByWorkspacePath[key] === tab) {
      const { [key]: _removed, ...rest } = current.activeTabByWorkspacePath;
      nextActiveTabByWorkspacePath = nextActiveTab ? { ...rest, [key]: nextActiveTab } : rest;
    }

    return {
      ...current,
      activeTabByWorkspacePath: nextActiveTabByWorkspacePath,
      tabsByWorkspacePath: nextTabsByWorkspacePath,
    };
  });
}

export function setActiveWorkspacePreviewTab(
  workspacePath: string | undefined,
  tab: WorkspacePreviewTab,
) {
  const key = workspacePreviewKey(workspacePath);
  workspacePreviewStore$.activeTabByWorkspacePath.set((current) => ({
    ...current,
    [key]: tab,
  }));
}

export function updateWorkspacePreviewWebState(
  workspacePath: string | undefined,
  patch: WorkspacePreviewWebState,
) {
  const key = workspacePreviewKey(workspacePath);

  workspacePreviewStore$.webStateByWorkspacePath.set((current) => {
    const previous = current[key] ?? {};
    const next = { ...previous, ...patch };

    if (
      previous.draft === next.draft &&
      previous.isUserControlled === next.isUserControlled &&
      previous.url === next.url
    ) {
      return current;
    }

    if (!next.draft && !next.isUserControlled && !next.url) {
      const { [key]: _removed, ...rest } = current;
      return rest;
    }

    return { ...current, [key]: next };
  });
}

export function resetWorkspacePreviewState() {
  workspacePreviewStore$.set(createDefaultWorkspacePreviewState());
}

function createDefaultWorkspacePreviewState(): WorkspacePreviewState {
  return {
    activeTabByWorkspacePath: {},
    tabsByWorkspacePath: {},
    webStateByWorkspacePath: {},
  };
}
