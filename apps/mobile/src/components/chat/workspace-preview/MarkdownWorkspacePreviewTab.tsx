import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ThemedText } from "@/components/themed-text";
import { Icon } from "@/components/ui/icon";
import { Colors, Spacing } from "@/constants/theme";
import { getWorkspaceFileContent } from "@/lib/codex-relay-api";
import { workspaceFileContentQueryKey } from "@/lib/workspace-file-queries";

import { HighlightedCodeBlock } from "../MessageBubble";
import type { WorkspaceMarkdownPreviewTarget } from "./markdown-target";
import { isMarkdownLanguage, WorkspaceMarkdownPreview } from "./WorkspaceMarkdownPreview";

export const MarkdownWorkspacePreviewTab = memo(function MarkdownWorkspacePreviewTab({
  serverUrl,
  target,
  workspaceId,
  workspacePath,
}: {
  serverUrl: string;
  target?: WorkspaceMarkdownPreviewTarget;
  workspaceId?: string;
  workspacePath?: string;
}) {
  const targetWorkspacePath = target?.workspacePath ?? workspacePath;
  const targetWorkspaceId = target?.workspacePath === workspacePath ? workspaceId : undefined;
  const [isPullRefreshing, setPullRefreshing] = useState(false);
  const fileContentQuery = useQuery({
    enabled: Boolean(target?.path),
    queryFn: () =>
      getWorkspaceFileContent({
        path: target?.path ?? "",
        workspaceId: targetWorkspaceId,
        workspacePath: targetWorkspacePath,
      }),
    queryKey: workspaceFileContentQueryKey(
      serverUrl,
      { workspaceId: targetWorkspaceId, workspacePath: targetWorkspacePath },
      target?.path ?? null,
    ),
    staleTime: 10_000,
  });
  const fileContent = fileContentQuery.data;
  const refreshFromPull = useCallback(async () => {
    if (!target?.path) {
      return;
    }
    setPullRefreshing(true);
    try {
      await fileContentQuery.refetch();
    } finally {
      setPullRefreshing(false);
    }
  }, [fileContentQuery, target?.path]);

  return (
    <View style={styles.contentPane}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            colors={[Colors.dark.text]}
            enabled={Boolean(target?.path)}
            progressBackgroundColor={Colors.dark.backgroundElement}
            refreshing={isPullRefreshing}
            tintColor={Colors.dark.text}
            onRefresh={() => void refreshFromPull()}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.documentHeader}>
          <View style={styles.documentIcon}>
            <Icon name="file" size={18} tintColor={Colors.dark.text} />
          </View>
          <View style={styles.documentTitleGroup}>
            <ThemedText type="smallBold" style={styles.documentTitle} numberOfLines={1}>
              {fileContent?.name ?? target?.name ?? "Markdown Preview"}
            </ThemedText>
            <ThemedText type="code" themeColor="textSecondary" numberOfLines={1}>
              {fileContent?.path ?? target?.path ?? "Open a Markdown attachment from chat."}
            </ThemedText>
          </View>
        </View>

        {!target?.path ? (
          <View style={styles.emptyState}>
            <ThemedText type="smallBold">No Markdown file selected</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Open a Markdown document from the chat attachment card.
            </ThemedText>
          </View>
        ) : fileContentQuery.isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={Colors.dark.textSecondary} size="small" />
            <ThemedText type="small" themeColor="textSecondary">
              Loading Markdown
            </ThemedText>
          </View>
        ) : fileContentQuery.error ? (
          <View style={styles.emptyState}>
            <ThemedText type="smallBold">Unable to load Markdown</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {errorMessage(fileContentQuery.error)}
            </ThemedText>
          </View>
        ) : fileContent?.binary ? (
          <View style={styles.emptyState}>
            <ThemedText type="smallBold">Binary file</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              This preview shows text files only.
            </ThemedText>
          </View>
        ) : fileContent ? (
          <View style={styles.previewFrame}>
            <View style={styles.metaRow}>
              <ThemedText type="code" themeColor="textSecondary" numberOfLines={1}>
                {fileMeta(fileContent)}
              </ThemedText>
            </View>
            {fileContent.truncated ? (
              <View style={styles.notice}>
                <ThemedText type="small" themeColor="textSecondary">
                  Previewing the first {formatBytes(Math.min(fileContent.size, 256 * 1024))}.
                </ThemedText>
              </View>
            ) : null}
            {isMarkdownLanguage(fileContent.language) ? (
              <WorkspaceMarkdownPreview markdown={fileContent.content} />
            ) : (
              <HighlightedCodeBlock
                code={fileContent.content}
                language={fileContent.language || languageFromPath(fileContent.path)}
              />
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
});

function fileMeta(file: { language: string; size: number; truncated: boolean }) {
  return [file.language || "text", formatBytes(file.size), file.truncated ? "truncated" : ""]
    .filter(Boolean)
    .join(" / ");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function languageFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension || "text";
}

const styles = StyleSheet.create({
  contentPane: {
    flex: 1,
    marginHorizontal: Spacing.three,
  },
  content: {
    gap: Spacing.two,
    paddingBottom: Spacing.four,
    paddingTop: Spacing.two,
  },
  documentHeader: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.055)",
    borderColor: "rgba(132, 145, 165, 0.2)",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: Spacing.two,
    padding: Spacing.two,
  },
  documentIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 8,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  documentTitleGroup: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  documentTitle: {
    fontSize: 14,
    lineHeight: 19,
  },
  emptyState: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: "rgba(132, 145, 165, 0.18)",
    borderRadius: 8,
    borderWidth: 1,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: Spacing.two,
    justifyContent: "center",
    padding: Spacing.three,
  },
  metaRow: {
    borderBottomColor: "rgba(132, 145, 165, 0.18)",
    borderBottomWidth: 1,
    paddingBottom: Spacing.two,
  },
  notice: {
    backgroundColor: "rgba(95, 167, 255, 0.08)",
    borderColor: "rgba(95, 167, 255, 0.18)",
    borderRadius: 8,
    borderWidth: 1,
    padding: Spacing.two,
  },
  previewFrame: {
    backgroundColor: "rgba(255, 255, 255, 0.055)",
    borderColor: "rgba(132, 145, 165, 0.2)",
    borderRadius: 8,
    borderWidth: 1,
    gap: Spacing.two,
    padding: Spacing.two,
  },
});
