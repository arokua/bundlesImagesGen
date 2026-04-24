import { formatProductLessonsBlock } from "@/lib/productLessons";
import { readLifestylePrefixOverrides } from "@/lib/lifestylePrefixOverrides";
import { readGlobalPromptRules } from "@/lib/promptRules";
import { readRenderSettings, type RenderSettings } from "@/lib/renderSettings";

/** Product-scoped lessons + saved global rules + optional lifestyle prompt prefix overrides. */
export async function readImagePromptExtras(masterSku: string): Promise<{
  lessonsBlock: string | null;
  globalRulesBlock: string | null;
  lifestylePromptPrefixMulti: string | null;
  lifestylePromptPrefixSingle: string | null;
  renderSettings: RenderSettings;
}> {
  const lessonsBlock = await formatProductLessonsBlock(masterSku);
  const globalRulesBlock = await readGlobalPromptRules();
  const { multi, single } = await readLifestylePrefixOverrides();
  const renderSettings = await readRenderSettings();
  return {
    lessonsBlock,
    globalRulesBlock,
    lifestylePromptPrefixMulti: multi,
    lifestylePromptPrefixSingle: single,
    renderSettings,
  };
}
