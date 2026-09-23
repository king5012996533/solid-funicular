/** 看一眼后台配置里的「生成进度阶段」文案（界面上的阶段标题就来自这里）。 */
import { prisma } from '../server/db/prisma.ts'

const rows = await prisma.systemSetting.findMany({ select: { code: true, name: true, configJson: true } })
console.log(`共 ${rows.length} 条系统设置`)
for (const row of rows) {
  const text = JSON.stringify(row.configJson || {})
  if (!/progress|进度|stage|阶段/i.test(row.code + row.name + text)) continue
  console.log(`\n--- ${row.code}（${row.name}）---`)
  const parsed = row.configJson
  const stages = parsed && typeof parsed === 'object' ? parsed.stages : null
  if (Array.isArray(stages)) {
    for (const stage of stages) console.log(`  ${String(stage.key).padEnd(28)} label=${JSON.stringify(stage.label)}`)
  } else {
    console.log(text.slice(0, 800))
  }
}
await prisma.$disconnect()
