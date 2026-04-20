import { formatProductLessonsBlock } from "@/lib/productLessons";
import { readLifestylePrefixOverrides } from "@/lib/lifestylePrefixOverrides";
import { readGlobalPromptRules } from "@/lib/promptRules";

/** Product-scoped lessons + saved global rules + optional lifestyle prompt prefix overrides. */
export async function readImagePromptExtras(masterSku: string): Promise<{
  lessonsBlock: string | null;
  globalRulesBlock: string | null;
  lifestylePromptPrefixMulti: string | null;
  lifestylePromptPrefixSingle: string | null;
}> {
  const lessonsBlock = await formatProductLessonsBlock(masterSku);
  const globalRulesBlock = await readGlobalPromptRules();
  const { multi, single } = await readLifestylePrefixOverrides();
  return {
    lessonsBlock,
    globalRulesBlock,
    lifestylePromptPrefixMulti: multi,
    lifestylePromptPrefixSingle: single,
  };
}
