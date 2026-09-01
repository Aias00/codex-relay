import type { RuntimeMode } from "@aias00/codex-relay/api-schema";

import { AppBottomSheet, SheetActionRow, SheetSelectedDot } from "@/components/ui/bottom-sheet";
import type { AppIconName } from "@/components/ui/icon";

export type RuntimePickerOption = {
  compactLabel: string;
  icon: AppIconName;
  iconBackgroundColor: string;
  iconTintColor: string;
  label: string;
  selectedTitleColor: string;
  subtitle: string;
  value: RuntimeMode;
};

export function RuntimeModeSheet({
  onClose,
  onSelect,
  runtimeMode,
  visible,
}: {
  onClose: () => void;
  onSelect: (mode: RuntimeMode) => void;
  runtimeMode: RuntimeMode;
  visible: boolean;
}) {
  const selectedMode = normalizeRuntimeMode(runtimeMode);

  return (
    <AppBottomSheet
      title="Permissions"
      subtitle="Set how much permission Codex can use."
      onClose={onClose}
      visible={visible}
    >
      {runtimeDisplayOptions.map((option) => {
        const selected = option.value === selectedMode;
        return (
          <SheetActionRow
            key={option.value}
            accessibilityLabel={option.label}
            icon={option.icon}
            iconBackgroundColor={option.iconBackgroundColor}
            iconTintColor={option.iconTintColor}
            onPress={() => onSelect(option.value)}
            selected={selected}
            selectedTitleColor={option.selectedTitleColor}
            subtitle={option.subtitle}
            title={option.label}
            trailing={<SheetSelectedDot selected={selected} />}
          />
        );
      })}
    </AppBottomSheet>
  );
}

export function runtimeOptionForMode(runtimeMode: RuntimeMode) {
  const normalized = normalizeRuntimeMode(runtimeMode);
  return (
    runtimeDisplayOptions.find((option) => option.value === normalized) ?? runtimeDisplayOptions[0]
  );
}

export function normalizeRuntimeMode(runtimeMode: RuntimeMode): RuntimeMode {
  return runtimeMode === "on-request" ? "default" : runtimeMode;
}

const runtimeDisplayOptions: RuntimePickerOption[] = [
  {
    compactLabel: "Default",
    icon: "permissionsDefault",
    iconBackgroundColor: "rgba(255, 255, 255, 0.08)",
    iconTintColor: "rgba(243, 244, 246, 0.72)",
    label: "Default permissions",
    selectedTitleColor: "rgba(243, 244, 246, 0.86)",
    subtitle: "Ask before sensitive actions",
    value: "default",
  },
  {
    compactLabel: "Auto",
    icon: "permissionsAuto",
    iconBackgroundColor: "rgba(125, 211, 252, 0.1)",
    iconTintColor: "rgba(125, 211, 252, 0.76)",
    label: "Auto",
    selectedTitleColor: "rgba(125, 211, 252, 0.9)",
    subtitle: "Run in workspace, ask after sandbox failures",
    value: "auto",
  },
  {
    compactLabel: "Full access",
    icon: "permissionsFull",
    iconBackgroundColor: "rgba(255, 138, 69, 0.1)",
    iconTintColor: "rgba(255, 171, 116, 0.76)",
    label: "Full access",
    selectedTitleColor: "rgba(255, 171, 116, 0.9)",
    subtitle: "Run without permission prompts",
    value: "full-access",
  },
];
