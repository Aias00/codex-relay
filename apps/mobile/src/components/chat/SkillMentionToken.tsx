import { promptSkillDisplayName, type PromptSkill } from "@aias00/codex-relay/api-schema";
import { memo } from "react";
import { Text as NativeText, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Icon } from "@/components/ui/icon";
import { Fonts } from "@/constants/theme";

export const SkillMentionToken = memo(function SkillMentionToken({
  fontSize,
  lineHeight,
  skill,
}: {
  fontSize: number;
  lineHeight: number;
  skill: PromptSkill;
}) {
  return (
    <View style={styles.container}>
      <Icon name="model" size={Math.max(11, fontSize)} tintColor="#8FD3FF" />
      <NativeText
        allowFontScaling={false}
        maxFontSizeMultiplier={1}
        numberOfLines={1}
        style={[styles.label, { fontSize, lineHeight }]}
      >
        {promptSkillDisplayName(skill)}
      </NativeText>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    paddingVertical: 2,
  },
  label: {
    color: "#9DD5FF",
    fontFamily: Fonts.sansSemiBold,
  },
});
