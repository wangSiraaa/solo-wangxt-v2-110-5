/**
 * 生成“发布前受影响链接与验证证据”报告：docs/verification-report.md
 *   node scripts/report.js
 * 会真实启动本地站点并执行一次版本化验证运行；报告基于该运行冻结的
 * 逐跳证据（run_items），带运行标识与输入摘要，不凭空下结论。
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../server/src/db.js';
import { buildFixtureApp } from '../server/src/fixture.js';
import { startRun, waitForRun, getRunItems, VERDICT_LABEL } from '../server/src/verify-runner.js';
import { summarizeRun, markInterruptedRuns } from '../server/src/run-service.js';
import { config } from '../server/src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GOOD = new Set(['ok', 'deleted_gone_ok']);
const fixtureMode = process.env.FIXTURE_MODE === 'fixed' ? 'fixed（整改修复已上线）' : 'default（保留缺陷的整改前状态）';

const fixture = await buildFixtureApp();
await fixture.listen({ host: config.fixture.host, port: config.fixture.port });
try {
  await markInterruptedRuns();
  const run = await startRun();
  const final = await waitForRun(run.id);
  const s = summarizeRun(final);
  const items = await getRunItems(run.id);
  const { rows: amb } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');

  const blocked = items.filter((v) => !GOOD.has(v.verdict));
  const passed = items.filter((v) => GOOD.has(v.verdict));
  const now = new Date().toISOString();

  const L = {
    redirect_loop: '🔁 重定向环', chain_too_long: '⏩ 跳转链过长',
    ambiguity: '⚖️ 归一化歧义', final_status_bad: '❌ 最终页状态异常',
    fetch_error: '🚫 请求被白名单拒绝/失败',
    deleted_not_gone: '🪦 已删除栏目未正确消亡',
  };

  let md = `# 栏目改版：旧链接落地验证报告（发布前证据）

> 生成时间：${now}
> **运行标识：#${s.id}（终态 ${s.status}）**
> 输入摘要：映射版本 \`${s.mapping_version}\`（${s.mapping_count} 条生效映射，${s.conflicted_count} 条歧义）；
> 策略版本 \`${s.policy_version}\`（尾斜杠=${s.policy_summary.tailSlashMode}，最长链=${s.policy_summary.maxRedirects}，超时=${s.policy_summary.timeoutMs}ms）
> 验证目标白名单：\`http://${config.fixture.host}:${config.fixture.port}\`（随项目启动的本地站点，仅此一个）
> 本地站点模式：**${fixtureMode}**
>
> **结论先行：${final.status !== 'complete' ? `运行未完整结束（${final.status}），本报告不能作为发布依据` : blocked.length === 0 ? '全部通过，可以发布' : `存在 ${blocked.length} 条受影响链接未通过，发布闸门保持关闭`}。**
> 映射表填完不等于迁移完成——下表每条都以真实 HTTP 请求的逐跳证据为准。
${(final.diagnostics ?? []).length ? `> 运行诊断：${final.diagnostics.join('；')}\n` : ''}
## 1. 总览

| 指标 | 数量 |
|---|---|
| 生效映射总数（去重后归一化键） | ${items.length} |
| 通过（最终页 2xx / 已删除正确 410） | ${passed.length} |
| 阻断 | ${blocked.length} |
| 归一化歧义组 | ${amb.length} |

## 2. 受影响链接（阻断项，必须处理后才能发布）

| 旧址 | 裁决 | 最终状态 | 跳数 | 问题 |
|---|---|---|---|---|
${blocked.map((v) => `| \`${v.source_raw}\` | ${L[v.verdict] ?? VERDICT_LABEL[v.verdict] ?? v.verdict} | ${v.final_status ?? '—'} | ${v.hops} | ${(v.issues || []).join('；') || '—'} |`).join('\n') || '| （无） | | | | |'}

## 3. 逐条验证证据（全部映射，运行 #${s.id} 冻结）

`;

  for (const v of items) {
    md += `### ${GOOD.has(v.verdict) ? '✅' : '❌'} ${v.source_raw}\n\n`;
    md += `- 裁决：**${VERDICT_LABEL[v.verdict]}**\n`;
    md += `- 最终 URL：\`${v.final_url_raw ?? '—'}\`\n`;
    md += `- 最终状态码：**${v.final_status ?? '—'}**；跳数：${v.hops}；追踪参数保留：${v.tracker_preserved === null ? '—' : v.tracker_preserved ? '是' : '否'}\n`;
    if (v.issues?.length) md += `- 问题：${v.issues.map((x) => `\n  - ${x}`).join('')}\n`;
    if (v.hops_detail?.length) {
      md += `\n| 跳 | 请求 URL（规范化） | 状态 | Location（原样） |\n|---|---|---|---|\n`;
      for (const h of v.hops_detail) {
        md += `| ${h.index} | \`${h.url_norm}\` | ${h.status ?? '—'}${h.fetch_error ? `（${h.fetch_error}）` : ''} | \`${h.location_raw ?? '—'}\` |\n`;
      }
    }
    md += '\n';
  }

  md += `## 4. 归一化歧义明细\n\n`;
  if (!amb.length) {
    md += '无。\n';
  } else {
    for (const a of amb) {
      md += `### ⚖️ \`${a.source_norm}\`\n\n`;
      md += `出现 ${a.input_count} 次录入、${a.target_variants} 个不同目标，禁止静默选一个：\n\n`;
      for (const s of a.source_forms) md += `- 录入写法：\`${s}\`\n`;
      for (const t of a.targets) md += `  - 声明目标：\`${t}\`\n`;
      md += '\n';
    }
  }

  md += `## 5. 处理建议（演示场景对应）

- **重定向环** \`/loop/a ↔ /loop/b\`：在旧站/新站边缘配置直跳，打断环。
- **过长链** \`/chain/0 → … → /chain/7\`（7 跳，> 上限 5）：旧地址直接 301 到 \`/chain/7\`。
- **大小写错误** \`/News/123\`：旧站无此资源（404），应改成真实存在的 \`/news/123\` 再迁移。
- **归一化歧义** \`/news/123\`：被两批导入（其中一条带 utm 参数）指向 \`/articles/123\` 与 \`/articles/999\`，需业务裁决唯一目标。
- **已删除栏目** \`/forum/announce/9\`：返回 410 Gone（已验证），不要 301 到首页稀释信号。
- **外网/非白名单地址** \`http://example.com/...\`：验证器拒绝请求；真实迁移中此类链接不属于本站，需剔除或走单独流程。

## 6. 复现方式

\`\`\`bash
npm run migrate && npm run seed && npm run verify   # CLI 裁决
npm start                                            # 工作台 http://127.0.0.1:4567
\`\`\`
`;

  const out = join(__dirname, '..', 'docs', 'verification-report.md');
  await writeFile(out, md, 'utf8');
  console.log(`report written: ${out}`);
  console.log(`run=#${s.id} status=${final.status} passed=${passed.length} blocked=${blocked.length} ambiguities=${amb.length}`);
} finally {
  await fixture.close();
  await pool.end();
}
