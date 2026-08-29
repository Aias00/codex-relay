import type { WorkspaceFileContentResponse } from "codex-relay/api-schema";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { ThemedText } from "@/components/themed-text";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WorkspaceCodeWebView } from "@/components/chat/workspace-preview/WorkspaceCodeWebView";
import { Colors, Spacing } from "@/constants/theme";
import { getWorkspaceFileContent, updateWorkspaceFileContent } from "@/lib/codex-relay-api";
import { getCodexRelayServerUrl } from "@/lib/codex-relay-api";
import { hapticSelection } from "@/lib/haptics";
import {
  workspaceFileContentQueryKey,
  workspaceFilesQueryKeyPrefix,
} from "@/lib/workspace-file-queries";

export default function WorkspaceFileEditorScreen() {
  const params = useLocalSearchParams<{
    path?: string;
    workspaceId?: string;
    workspacePath?: string;
  }>();
  const path = normalizedParam(params.path);
  const workspaceId = normalizedParam(params.workspaceId);
  const workspacePath = normalizedParam(params.workspacePath);
  const serverUrl = getCodexRelayServerUrl();
  const workspaceSelection = { workspaceId, workspacePath };
  const queryClient = useQueryClient();
  const keyboardAvoidingEnabled = useKeyboardState(
    (state) => state.isVisible && state.height > 120,
  );
  const [draftContent, setDraftContent] = useState("");
  const fileContentQueryKey = workspaceFileContentQueryKey(
    serverUrl,
    workspaceSelection,
    path ?? null,
  );
  const fileContentQuery = useQuery({
    enabled: Boolean(path),
    queryFn: () => getWorkspaceFileContent({ path: path ?? "", workspaceId, workspacePath }),
    queryKey: fileContentQueryKey,
    staleTime: 10_000,
  });
  const fileContent = fileContentQuery.data;
  const canEditFile = Boolean(fileContent && !fileContent.binary && !fileContent.truncated);
  const savedContent = fileContent?.content ?? "";
  const isDirty = canEditFile && draftContent !== savedContent;
  const editorLanguage = fileContent?.language || languageFromPath(fileContent?.path ?? path ?? "");
  const lineCount = lineCountFor(draftContent || fileContent?.content || "");
  const saveFileMutation = useMutation({
    mutationFn: (input: { content: string; path: string }) =>
      updateWorkspaceFileContent({
        content: input.content,
        path: input.path,
        workspaceId,
        workspacePath,
      }),
    onSuccess: (nextFile, input) => {
      const nextFileContentQueryKey = workspaceFileContentQueryKey(
        serverUrl,
        workspaceSelection,
        input.path,
      );
      queryClient.setQueryData(nextFileContentQueryKey, nextFile);
      void queryClient.invalidateQueries({ queryKey: nextFileContentQueryKey });
      void queryClient.invalidateQueries({
        queryKey: workspaceFilesQueryKeyPrefix(serverUrl, workspaceSelection),
      });
      setDraftContent(nextFile.content);
      hapticSelection();
    },
  });
  const saveFileError = saveFileMutation.error;
  const isSavingFile = saveFileMutation.isPending;
  const canSaveFile = isDirty && !isSavingFile;
  const mutateSaveFile = saveFileMutation.mutate;

  useEffect(() => {
    setDraftContent(fileContent?.content ?? "");
  }, [fileContent?.content, fileContent?.path]);

  const closeEditor = useCallback(() => {
    void KeyboardController.dismiss().catch(() => undefined);
    if (!isDirty) {
      router.back();
      return;
    }
    Alert.alert("Discard changes?", "Your unsaved edits will be lost.", [
      {
        text: "Keep Editing",
        style: "cancel",
      },
      {
        onPress: () => router.back(),
        style: "destructive",
        text: "Discard",
      },
    ]);
  }, [isDirty]);

  const saveEditing = useCallback(() => {
    if (!path || !canEditFile || !canSaveFile) {
      return;
    }
    void KeyboardController.dismiss().catch(() => undefined);
    mutateSaveFile({ content: draftContent, path });
  }, [canEditFile, canSaveFile, draftContent, mutateSaveFile, path]);

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={styles.screen}>
      <KeyboardAvoidingView
        automaticOffset
        behavior="height"
        enabled={keyboardAvoidingEnabled}
        keyboardVerticalOffset={0}
        style={styles.keyboardAwareContent}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close file editor"
            onPress={closeEditor}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Icon name="back" size={18} tintColor={Colors.dark.text} />
          </Pressable>
          <View style={styles.titleGroup}>
            <ThemedText type="smallBold" numberOfLines={1} style={styles.title}>
              {fileContent?.name ?? path?.split("/").pop() ?? "File Editor"}
            </ThemedText>
            <ThemedText type="code" themeColor="textSecondary" numberOfLines={1}>
              {fileContent?.path ?? path ?? "Workspace"}
            </ThemedText>
          </View>
          <Button
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSaveFile }}
            disabled={!canSaveFile}
            onPress={saveEditing}
            size="sm"
            variant="default"
            className="h-9 min-w-[62px] rounded-md px-3"
          >
            <Text variant="small">{isSavingFile ? "Saving" : "Save"}</Text>
          </Button>
        </View>

        <View style={styles.metaBar}>
          <ThemedText type="code" themeColor="textSecondary" numberOfLines={1}>
            {fileContent ? `${fileMeta(fileContent)} / ${lineCount} lines` : (workspacePath ?? "")}
          </ThemedText>
        </View>

        {saveFileError ? (
          <View style={styles.noticeError}>
            <ThemedText type="small" themeColor="textSecondary">
              {errorMessage(saveFileError)}
            </ThemedText>
          </View>
        ) : null}

        <View style={styles.editorShell}>
          {!path ? (
            <EditorState title="Missing file" message="No workspace file path was provided." />
          ) : fileContentQuery.isLoading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={Colors.dark.textSecondary} size="small" />
              <ThemedText type="small" themeColor="textSecondary">
                Loading file
              </ThemedText>
            </View>
          ) : fileContentQuery.error ? (
            <EditorState
              title="Unable to load file"
              message={errorMessage(fileContentQuery.error)}
            />
          ) : fileContent?.binary ? (
            <EditorState title="Binary file" message="This editor supports text files only." />
          ) : fileContent?.truncated ? (
            <EditorState
              title="File too large"
              message="Large truncated previews cannot be edited."
            />
          ) : fileContent ? (
            <WorkspaceCodeWebView
              key={`${fileContent.path}:editor:${fileContent.size}`}
              fill
              language={editorLanguage}
              lineNumbers
              mode="editor"
              value={draftContent}
              onChangeText={setDraftContent}
            />
          ) : (
            <EditorState
              title="File not found"
              message="Select another file from Workspace Preview."
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function EditorState({ message, title }: { message: string; title: string }) {
  return (
    <View style={styles.emptyState}>
      <ThemedText type="smallBold">{title}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {message}
      </ThemedText>
    </View>
  );
}

function normalizedParam(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const normalized = rawValue?.trim();
  return normalized ? normalized : undefined;
}

function lineCountFor(value: string) {
  if (!value) {
    return 1;
  }
  return value.split(/\r\n|\r|\n/).length;
}

function fileMeta(file: WorkspaceFileContentResponse) {
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
  screen: {
    backgroundColor: Colors.dark.background,
    flex: 1,
  },
  keyboardAwareContent: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    alignItems: "center",
    borderBottomColor: "rgba(132, 145, 165, 0.16)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: Spacing.two,
    minHeight: 58,
    paddingHorizontal: Spacing.three,
  },
  iconButton: {
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: 17,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    lineHeight: 19,
  },
  metaBar: {
    borderBottomColor: "rgba(132, 145, 165, 0.12)",
    borderBottomWidth: 1,
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: Spacing.three,
  },
  editorShell: {
    flex: 1,
    minHeight: 0,
    padding: Spacing.two,
  },
  loadingState: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: Spacing.two,
    justifyContent: "center",
  },
  emptyState: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderColor: "rgba(132, 145, 165, 0.2)",
    borderCurve: "continuous",
    borderRadius: 8,
    borderWidth: 1,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  noticeError: {
    backgroundColor: "rgba(255, 107, 107, 0.1)",
    borderColor: "rgba(255, 107, 107, 0.24)",
    borderCurve: "continuous",
    borderRadius: 7,
    borderWidth: 1,
    marginHorizontal: Spacing.three,
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },
});
