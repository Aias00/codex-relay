import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useSelector } from "@legendapp/state/react";
import type { ThreadSummary } from "@aias00/codex-relay/api-schema";
import { memo, useCallback } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";
import { threadAttentionLabel, threadAttentionState } from "@/lib/thread-attention";
import { chatStore$, threadHasUnseenCompletion } from "@/state/chat-store";

const THREAD_ITEM_WIDTH = 190;
const THREAD_ITEM_ESTIMATED_SIZE = THREAD_ITEM_WIDTH + Spacing.two;

export function ThreadList({
  activeThreadId,
  onSelectThread,
  threads,
}: {
  activeThreadId?: string;
  onSelectThread: (threadId: string) => void;
  threads: ThreadSummary[];
}) {
  const threadSeenState = useSelector(() => chatStore$.threadSeenState.get());
  const renderThread = useCallback(
    ({ item }: LegendListRenderItemProps<ThreadSummary>) => (
      <ThreadListItem
        activeThreadId={activeThreadId}
        hasUnseenCompletion={threadHasUnseenCompletion(item, threadSeenState)}
        onSelectThread={onSelectThread}
        thread={item}
      />
    ),
    [activeThreadId, onSelectThread, threadSeenState],
  );

  return (
    <View style={styles.container}>
      <LegendList
        horizontal
        data={threads}
        keyExtractor={threadKeyExtractor}
        estimatedItemSize={THREAD_ITEM_ESTIMATED_SIZE}
        getFixedItemSize={() => THREAD_ITEM_ESTIMATED_SIZE}
        recycleItems={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        renderItem={renderThread}
      />
    </View>
  );
}

const ThreadListItem = memo(function ThreadListItem({
  activeThreadId,
  hasUnseenCompletion,
  onSelectThread,
  thread,
}: {
  activeThreadId?: string;
  hasUnseenCompletion: boolean;
  onSelectThread: (threadId: string) => void;
  thread: ThreadSummary;
}) {
  const selected = thread.id === activeThreadId;
  const attention = threadAttentionState({
    goalStatus: thread.goal?.status,
    hasUnseenCompletion,
    threadState: thread.state,
  });
  const handlePress = useCallback(() => onSelectThread(thread.id), [onSelectThread, thread.id]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.item,
        selected && styles.itemSelected,
        pressed && styles.pressed,
      ]}
    >
      <ThemedText type="smallBold" numberOfLines={1}>
        {thread.title}
      </ThemedText>
      <ThemedText type="code" themeColor="textSecondary" numberOfLines={1}>
        {threadAttentionLabel(attention)} · {thread.messageCount} messages
      </ThemedText>
    </Pressable>
  );
});

function threadKeyExtractor(thread: ThreadSummary) {
  return thread.id;
}

const styles = StyleSheet.create({
  container: {
    minHeight: 70,
  },
  content: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  item: {
    borderColor: "rgba(132, 145, 165, 0.18)",
    borderRadius: 8,
    borderWidth: 1,
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    width: THREAD_ITEM_WIDTH,
  },
  itemSelected: {
    backgroundColor: "rgba(95, 167, 255, 0.16)",
    borderColor: "rgba(95, 167, 255, 0.42)",
  },
  pressed: {
    opacity: 0.72,
  },
});
