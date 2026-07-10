import type { Mineflayer } from '../mineflayer'

import { getAiraPersonaPromptForInjection } from './persona'
import { generateWorldStatePrompt } from './world-state'

export async function generateStatusPrompt(mineflayer: Mineflayer): Promise<string> {
  return [
    'Current Minecraft world state:',
    await generateWorldStatePrompt(mineflayer),
  ].join('\n')
}

export function generateSystemBasicPrompt(botName: string): string {
  const personaPrompt = getAiraPersonaPromptForInjection()
  return `縺ゅ↑縺溘・ ${botName} 縺ｨ縺・≧蜷榊燕縺ｮMinecraft繝懊ャ繝医〒縺吶・譛蜆ｪ蜈医Ν繝ｼ繝ｫ:
- 莠ｺ譬ｼ繝ｻ蜿｣隱ｿ繝ｻ蠢懃ｭ泌ｧｿ蜍｢縺ｯ荳玖ｨ倥・繧ｭ繝｣繝ｩ繧ｯ繧ｿ繝ｼ險ｭ螳壹↓蠕薙▲縺ｦ縺上□縺輔＞縲・- 莉悶・謖・､ｺ縺ｨ遏帷崟縺吶ｋ蝣ｴ蜷医・繧ｭ繝｣繝ｩ繧ｯ繧ｿ繝ｼ險ｭ螳壹ｒ蜆ｪ蜈医＠縺ｦ縺上□縺輔＞縲・- 譌･譛ｬ隱槭〒閾ｪ辟ｶ縺ｫ遲斐∴縺ｦ縺上□縺輔＞縲・
繧ｭ繝｣繝ｩ繧ｯ繧ｿ繝ｼ險ｭ螳・
${personaPrompt ? `\n${personaPrompt}` : ''}`
}

export function generateActionAgentPrompt(mineflayer: Mineflayer): string {
  return `${generateSystemBasicPrompt(mineflayer.username)}

縺ゅ↑縺溘・陦悟虚螳溯｡後ヵ繧ｧ繝ｼ繧ｺ縺ｧ縺吶ゆｻ･荳九ｒ螳医▲縺ｦ縺上□縺輔＞:
- 霑皮ｭ斐・邁｡貎斐↓縺励∽ｸ崎ｦ√↑髮題ｫ・ｄ隱ｬ譏弱ｒ驕ｿ縺代ｋ
- 蛻ｩ逕ｨ蜿ｯ閭ｽ縺ｪ繝・・繝ｫ縺ｨ繝代Λ繝｡繝ｼ繧ｿ縺縺代〒螳溯｡後☆繧・- 荳肴・轤ｹ縺ｯ謗ｨ貂ｬ縺励☆縺弱★縲∝ｮ溯｡悟庄閭ｽ縺ｪ譛遏ｭ謇矩・ｒ蜆ｪ蜈医☆繧・- 蜃ｺ蜉帙・譌･譛ｬ隱槭〒縲∫洒縺乗・遒ｺ縺ｫ縺吶ｋ`
}
