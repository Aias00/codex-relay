import type { CodexModel, ReasoningEffort } from "@aias00/codex-relay/api-schema";
import { useEffect, useState } from "react";

import { AppBottomSheet } from "@/components/ui/bottom-sheet";

import { AdvancedModelOptions, type AdvancedSection } from "./AdvancedModelOptions";
import {
  defaultPowerSelection,
  fastServiceTierForModel,
  modelPickerSheetPresentation,
  powerSelectionsForModels,
  selectedPowerSelection,
  type PowerSelection,
} from "./model-picker-options";
import { PowerSelector } from "./PowerSelector";

export function ChatModelPickerSheet({
  activeModel,
  models,
  onClose,
  onModelSelect,
  onReasoningSelect,
  onServiceTierChange,
  selectedModel,
  selectedReasoningEffort,
  selectedServiceTier,
  visible,
}: {
  activeModel: CodexModel | undefined;
  models: CodexModel[];
  onClose: () => void;
  onModelSelect: (model: string, reasoningEffort?: ReasoningEffort) => void;
  onReasoningSelect: (reasoningEffort: ReasoningEffort) => void;
  onServiceTierChange: (serviceTier: string | undefined) => void;
  selectedModel: string | undefined;
  selectedReasoningEffort: ReasoningEffort | undefined;
  selectedServiceTier: string | undefined;
  visible: boolean;
}) {
  const [viewMode, setViewMode] = useState<"advanced" | "compact">();
  const [advancedSection, setAdvancedSection] = useState<AdvancedSection | undefined>();
  const powerSelections = powerSelectionsForModels(models);
  const effectiveSelectedModel = selectedModel ?? activeModel?.model;
  const selectedPower = selectedPowerSelection(
    powerSelections,
    effectiveSelectedModel,
    selectedReasoningEffort,
  );
  const hasCompactPower = powerSelections.length >= 4;
  const hasCustomSelection = hasCompactPower && Boolean(effectiveSelectedModel) && !selectedPower;
  const showAdvanced =
    !hasCompactPower || viewMode === "advanced" || (viewMode !== "compact" && hasCustomSelection);
  const presentation = modelPickerSheetPresentation(showAdvanced, hasCompactPower);
  const fastServiceTier = fastServiceTierForModel(activeModel);
  const isFastModeEnabled = Boolean(fastServiceTier && selectedServiceTier === fastServiceTier.id);

  useEffect(() => {
    if (!visible) {
      setViewMode(undefined);
      setAdvancedSection(undefined);
      return;
    }
    if (!hasCompactPower || hasCustomSelection) {
      setViewMode("advanced");
    }
  }, [hasCompactPower, hasCustomSelection, visible]);

  function selectPower(selection: PowerSelection, returnToCompact = false) {
    onModelSelect(selection.model, selection.reasoningEffort);
    if (returnToCompact) {
      setViewMode("compact");
      setAdvancedSection(undefined);
    }
  }

  function returnToCompactPower() {
    if (!selectedPower) {
      const fallback = defaultPowerSelection(powerSelections);
      if (fallback) {
        selectPower(fallback, true);
        return;
      }
    }
    setViewMode("compact");
    setAdvancedSection(undefined);
  }

  return (
    <AppBottomSheet
      backAccessibilityLabel="Back to Power"
      title={showAdvanced ? "Advanced" : "Power"}
      subtitle={
        showAdvanced
          ? "Choose the model, reasoning effort, and response speed."
          : "Balance faster replies with smarter reasoning."
      }
      enableDynamicSizing={presentation.enableDynamicSizing}
      expandedSnapPercent={presentation.expandedSnapPercent}
      initialSnapIndex={presentation.initialSnapIndex}
      onBack={presentation.showBackButton ? returnToCompactPower : undefined}
      onClose={onClose}
      scrollable={presentation.scrollable}
      visible={visible}
    >
      {!showAdvanced ? (
        <>
          <PowerSelector
            fastAvailable={Boolean(fastServiceTier)}
            fastEnabled={isFastModeEnabled}
            onAdvancedPress={() => setViewMode("advanced")}
            onFastChange={(enabled) =>
              onServiceTierChange(enabled ? fastServiceTier?.id : undefined)
            }
            onSelect={(selection) => selectPower(selection)}
            selected={selectedPower}
            selections={powerSelections}
          />
        </>
      ) : null}

      {showAdvanced ? (
        <AdvancedModelOptions
          activeSection={advancedSection}
          activeModel={activeModel}
          models={models}
          onModelSelect={onModelSelect}
          onReasoningSelect={onReasoningSelect}
          onSectionChange={setAdvancedSection}
          onServiceTierChange={onServiceTierChange}
          selectedModel={effectiveSelectedModel}
          selectedReasoningEffort={selectedReasoningEffort}
          selectedServiceTier={selectedServiceTier}
        />
      ) : null}
    </AppBottomSheet>
  );
}
