import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ThemedText } from "@/components/themed-text";
import { Spacing } from "@/constants/theme";

export function RunningFooter() {
  return (
    <View style={styles.runningFooter}>
      <View style={styles.dots}>
        <View style={styles.dot} />
        <View style={styles.dot} />
        <View style={styles.dot} />
      </View>
      <ThemedText type="code" themeColor="textSecondary">
        Working…
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    backgroundColor: "rgba(176, 180, 186, 0.55)",
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  dots: {
    flexDirection: "row",
    gap: 3,
  },
  runningFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: Spacing.two,
    justifyContent: "center",
    paddingBottom: Spacing.four,
    paddingTop: Spacing.two,
  },
});
