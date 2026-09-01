import {
  isPromptSkillMarkdownMention,
  promptSkillDisplayName,
  promptMarkdownWithSkills,
  type PromptSkill,
} from "@aias00/codex-relay/api-schema";
import { memo, useMemo } from "react";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";

import { Fonts } from "@/constants/theme";

export const PromptMarkdownText = memo(function PromptMarkdownText({
  color,
  fontSize = 14,
  lineHeight,
  markdownStyle,
  prompt,
  selectable = false,
  skills,
}: {
  color: string;
  fontSize?: number;
  lineHeight: number;
  markdownStyle?: MarkdownStyle;
  prompt: string;
  selectable?: boolean;
  skills: PromptSkill[];
}) {
  const markdown = useMemo(() => promptMarkdownWithSkills(prompt, skills), [prompt, skills]);
  const displayMarkdown = useMemo(
    () => markdownWithDisplaySkillLabels(markdown, skills),
    [markdown, skills],
  );
  const style = useMemo<MarkdownStyle>(
    () => ({
      ...markdownStyle,
      link: {
        color: "#7CC7FF",
        fontFamily: Fonts.sansSemiBold,
        underline: false,
        ...markdownStyle?.link,
      },
      paragraph: {
        color,
        fontFamily: Fonts.sans,
        fontSize,
        lineHeight,
        marginBottom: 0,
        marginTop: 0,
        ...markdownStyle?.paragraph,
      },
    }),
    [color, fontSize, lineHeight, markdownStyle],
  );

  if (!displayMarkdown) {
    return null;
  }

  return (
    <EnrichedMarkdownText
      allowFontScaling={false}
      allowTrailingMargin={false}
      markdown={displayMarkdown || " "}
      markdownStyle={style}
      maxFontSizeMultiplier={1}
      selectable={selectable}
    />
  );
});

function markdownWithDisplaySkillLabels(markdown: string, skills: PromptSkill[]) {
  const linkRegex = /\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)/g;
  return markdown.replace(linkRegex, (match, label: string, url: string) => {
    const skill =
      skills.find((candidate) => isPromptSkillMarkdownMention(label, url, [candidate])) ??
      skillFromMarkdownMention(label, url);
    return skill
      ? `[${escapeMarkdownLabel(promptSkillDisplayName(skill))}](${skillDisplayUrl(skill)})`
      : match;
  });
}

function skillDisplayUrl(skill: PromptSkill) {
  return `https://codex.local/skills/${encodeURIComponent(skill.name)}`;
}

function skillFromMarkdownMention(label: string, url: string): PromptSkill | undefined {
  const path = normalizeMarkdownUrl(url);
  if (!path.endsWith("/SKILL.md")) {
    return undefined;
  }
  const labelName = unescapeMarkdownLabel(label).trim().replace(/^\$/, "");
  const pathName = path.match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
  const name = pathName || labelName;
  if (!name) {
    return undefined;
  }
  return { name, path };
}

function unescapeMarkdownLabel(value: string) {
  return value.replace(/\\([\\[\]])/g, "$1");
}

function normalizeMarkdownUrl(value: string) {
  const unwrapped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function escapeMarkdownLabel(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}
