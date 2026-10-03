/**
 * 命令行验证：npm run verify
 * 启动一次版本化运行（冻结映射/策略版本），等待终态后输出每条裁决。
 * 只有 complete 的全量运行才会推进发布基线；failed/cancelled 保留诊断。
 */
import { pool } from './db.js';
import { startFixture } from './fixture.js';
import { startRun, waitForRun, getRunItems, VERDICT_LABEL } from './verify-runner.js';
import { markInterruptedRuns } from './run-service.js';

const fixture = await startFixture();
try {
  await markInterruptedRuns();
  const run = await startRun();
  console.log(`运行 #${run.id} 已启动（映射版本 ${run.mapping_version.slice(0, 12)}…，策略版本 ${run.policy_version.slice(0, 12)}…）`);
  const final = await waitForRun(run.id);
  const items = await getRunItems(run.id);

  console.log('\n===== 链接验证结果 =====');
  for (const r of items) {
    const tag = r.verdict === 'ok' || r.verdict === 'deleted_gone_ok' ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${VERDICT_LABEL[r.verdict] ?? r.verdict}  hops=${r.hops ?? '-'}  ${r.source_norm}`);
    for (const i of r.issues ?? []) console.log(`       - ${i}`);
  }
  const bad = items.filter(
    (r) => r.verdict !== 'ok' && r.verdict !== 'deleted_gone_ok',
  );
  console.log(`\n运行 #${run.id} 终态：${final.status}`);
  for (const d of final.diagnostics ?? []) console.log(`  诊断: ${d}`);
  console.log(`共 ${items.length} 条，通过 ${items.length - bad.length}，阻断 ${bad.length}`);
  process.exitCode = final.status !== 'complete' || bad.length ? 2 : 0;
} finally {
  await fixture.close();
  await pool.end();
}
