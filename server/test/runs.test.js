/**
 * 版本化运行历史验收测试（真实数据库 + 真实本地站点）：
 *  ① 同一映射和策略连续两次完整验证 → 稳定比较，无业务变化；
 *  ② 修复重定向环后，新运行只把相应入口列为已修复，旧逐跳证据仍可回看；
 *  ③ 取消 / 本地站点超时 → 运行不完整，基线仍是上一完整兼容运行；
 *  ④ 映射或策略变化 → 比较提示输入不兼容，旧 run 不能给新方案放行；
 *  ⑤ 方案详情 / 导出报告始终带运行链、差异结论与不可作基线的原因。
 *
 * 独立测试库 url_migration_test + 独立站点端口 4569（与其它测试文件并行安全）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGDATABASE = 'url_migration_test';
process.env.FIXTURE_PORT = '4569';

const { ensureDatabase, pool } = await import('../src/db.js');
const { startFixture } = await import('../src/fixture.js');
const { normalize } = await import('../src/normalize.js');
const { recomputeMappings } = await import('../src/mappings-service.js');
const { config, fixtureOrigin } = await import('../src/config.js');
const {
  startRun, waitForRun, cancelRun, getRunItems,
} = await import('../src/verify-runner.js');
const {
  currentBaseline, compareRuns, getRun, baselineEligibility, currentVersions,
  markInterruptedRuns,
} = await import('../src/run-service.js');
const { default: apiRoutes } = await import('../src/routes.js');
const { default: Fastify } = await import('fastify');

const O = fixtureOrigin();
const K = {
  news: normalize(`${O}/news/123`).normKey,
  loop: normalize(`${O}/loop/a`).normKey,
  forum: normalize(`${O}/forum/announce/9`).normKey,
  chain: normalize(`${O}/chain/0`).normKey,
  column: normalize(`${O}/column/weekly/`).normKey,
  files: normalize(`${O}/old-files%2Fdraft`).normKey,
};

let fixture;
let app;

async function restartFixture(mode) {
  await fixture.close();
  process.env.FIXTURE_MODE = mode;
  fixture = await startFixture();
}

async function addInput(sourceRaw, targetRaw, mappingType = 'manual') {
  const s = normalize(sourceRaw);
  const t = normalize(targetRaw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [sourceRaw, s.normKey, targetRaw, t.normKey, mappingType]);
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function removeInput(sourceNorm) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [sourceNorm]);
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function runToEnd(opts) {
  const run = await startRun(opts);
  return waitForRun(run.id);
}

const verdictOf = async (runId, key) =>
  (await getRunItems(runId)).find((i) => i.source_norm === key);

before(async () => {
  await ensureDatabase();
  await pool.query(
    `TRUNCATE migration_plan_items, migration_plans, verification_verdicts,
              crawl_results, run_items, verification_runs,
              url_mappings, mapping_inputs RESTART IDENTITY CASCADE`);
  await addInput(`${O}/news/123`, `${O}/articles/123`);
  await addInput(`${O}/loop/a`, `${O}/loop/b`);
  await addInput(`${O}/forum/announce/9`, `${O}/forum/announce/9`, 'deleted');
  await addInput(`${O}/chain/0`, `${O}/chain/7`);
  process.env.FIXTURE_MODE = 'default';
  fixture = await startFixture();
  app = Fastify();
  await app.register(apiRoutes);
});

after(async () => {
  await app?.close();
  await fixture?.close();
  await pool.end();
});

// 运行 id 跨测试共享（按定义顺序依次执行）
let runA; let runA2; let runB; let runC;

test('运行 A 完整结束并成为当前基线（证据表带 run_id）', async () => {
  runA = await runToEnd();
  assert.equal(runA.status, 'complete');
  assert.equal(runA.scope, 'all');
  assert.equal(runA.total, 4);
  const baseline = await currentBaseline();
  assert.equal(baseline.id, runA.id);
  assert.equal((await verdictOf(runA.id, K.loop)).verdict, 'redirect_loop');
  assert.equal((await verdictOf(runA.id, K.chain)).verdict, 'chain_too_long');
  const { rows } = await pool.query('SELECT DISTINCT run_id FROM verification_verdicts');
  assert.deepEqual(rows.map((r) => r.run_id), [runA.id]);
});

test('① 同一映射+策略连续两次完整运行 → 稳定比较、无业务变化', async () => {
  runA2 = await runToEnd();
  assert.equal(runA2.status, 'complete');
  assert.equal(runA2.mapping_version, runA.mapping_version);
  assert.equal(runA2.policy_version, runA.policy_version);

  const cmp = await compareRuns(runA.id, runA2.id);
  assert.equal(cmp.compatible, true);
  assert.equal(cmp.stable, true, '两次完整运行应无业务变化');
  assert.deepEqual(cmp.buckets.fixed, []);
  assert.deepEqual(cmp.buckets.regressed, []);
  assert.deepEqual(cmp.buckets.new_failures, []);
  assert.deepEqual(cmp.buckets.not_comparable, []);
  assert.equal(cmp.counts.unchanged_good, 2); // news ok + forum 410
  assert.equal(cmp.counts.unchanged_bad, 2);  // loop 环 + chain 长链
});

test('② 修复重定向环后：新运行只把 /loop/a 列为已修复，旧逐跳证据仍可回看', async () => {
  await restartFixture('fixloop'); // 站点侧只修环：/loop/b 变成 200 最终页
  runB = await runToEnd();
  assert.equal(runB.status, 'complete');
  assert.equal(runB.fixture_mode, 'fixloop');
  assert.equal((await verdictOf(runB.id, K.loop)).verdict, 'ok');

  const cmp = await compareRuns(runA.id, runB.id);
  assert.equal(cmp.compatible, true, '站点修复不是输入变化，运行仍可比较');
  assert.equal(cmp.stable, false);
  assert.deepEqual(cmp.buckets.fixed.map((e) => e.source_norm), [K.loop]);
  assert.deepEqual(cmp.buckets.regressed, []);
  assert.deepEqual(cmp.buckets.new_failures, []);
  assert.deepEqual(cmp.buckets.not_comparable, []);
  assert.equal(cmp.counts.unchanged_bad, 1); // 长链仍未修

  // 旧运行 A 的逐跳证据未被覆盖，仍可回看
  const oldItem = await verdictOf(runA.id, K.loop);
  assert.equal(oldItem.verdict, 'redirect_loop');
  assert.ok(oldItem.hops_detail.length >= 2, '旧运行的逐跳链应冻结保存');
  assert.equal(oldItem.hops_detail.at(-1).note, 'loop-repeat');
});

test('③ 运行中取消 → cancelled + 诊断保留，基线仍是上一完整运行', async () => {
  const run = await startRun({ itemDelayMs: 150 });
  // 等至少一个条目完成后再取消
  for (;;) {
    const r = await getRun(run.id);
    if (r.done_count >= 1) break;
    await new Promise((s) => setTimeout(s, 30));
  }
  // 进行中不允许并发启动第二个运行
  await assert.rejects(() => startRun(), /仍在进行中/);
  assert.equal(await cancelRun(run.id), true);
  const final = await waitForRun(run.id);
  assert.equal(final.status, 'cancelled');
  assert.ok(final.done_count < final.total, '取消的运行不应覆盖全部条目');
  assert.ok(final.diagnostics.some((d) => d.includes('取消')), '诊断应记录取消');
  assert.ok((await getRunItems(run.id)).length >= 1, '已完成条目证据保留');

  const baseline = await currentBaseline();
  assert.equal(baseline.id, runB.id, '取消的运行绝不能替换完整基线');
  const { rows } = await pool.query('SELECT DISTINCT run_id FROM verification_verdicts');
  assert.deepEqual(rows.map((r) => r.run_id), [runB.id], '当前证据表仍属于基线运行');
});

test('③ 本地站点不可达（超时/拒绝）→ failed + 诊断保留，基线不变', async () => {
  await fixture.close(); // 模拟本地站点宕机：所有请求连接被拒绝
  const failed = await runToEnd();
  assert.equal(failed.status, 'failed');
  assert.ok(failed.diagnostics.some((d) => d.includes('预检失败')), JSON.stringify(failed.diagnostics));
  assert.equal((await getRunItems(failed.id)).length, 0, '预检失败不应产生任何条目裁决');

  const baseline = await currentBaseline();
  assert.equal(baseline.id, runB.id, '失败的运行不能假装成功、不能替换基线');
  await restartFixture('fixloop');
});

test('④ 映射变化 → 比较提示输入不兼容；策略变化 → 旧运行失去基线资格', async () => {
  await addInput(`${O}/column/weekly/`, `${O}/sections/weekly`);
  assert.equal(await currentBaseline(), null, '映射已变，旧完整运行不再是基线');

  runC = await runToEnd();
  assert.equal(runC.status, 'complete');
  assert.notEqual(runC.mapping_version, runB.mapping_version);

  const cmp = await compareRuns(runB.id, runC.id);
  assert.equal(cmp.compatible, false);
  assert.ok(cmp.reasons.some((r) => r.includes('映射版本')), '应明确提示映射输入不兼容');
  assert.equal(cmp.buckets, undefined, '不兼容时不应给出业务差异');

  // 策略变化（例如尾斜杠策略）→ 当前完整运行立刻失去基线资格
  const keep = config.rules.tailSlashMode;
  config.rules.tailSlashMode = 'ignore';
  try {
    assert.equal(await currentBaseline(), null);
    const elig = baselineEligibility(await getRun(runC.id), await currentVersions());
    assert.equal(elig.eligible, false);
    assert.ok(elig.reasons.some((r) => r.includes('策略')));
  } finally {
    config.rules.tailSlashMode = keep;
  }
  assert.equal((await currentBaseline()).id, runC.id, '策略恢复后 runC 重新兼容');
});

test('④⑤ 旧 run 不能给新方案放行；方案详情给出运行链与不可作基线的原因', async () => {
  // 基于当前基线 runC 构建方案
  const planRes = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: '验收方案-A' } });
  const planId = planRes.json().id;
  const build = await app.inject({ method: 'POST', url: `/api/plans/${planId}/build` });
  assert.equal(build.json().baseline_run_id, runC.id);

  // 映射再次变化（新增一条映射）→ 方案所依据的运行失效
  await addInput(`${O}/old-files%2Fdraft`, `${O}/files%2Fdraft`);
  const pub = await app.inject({ method: 'POST', url: `/api/plans/${planId}/publish`, payload: {} });
  assert.equal(pub.statusCode, 409);
  const reasons = pub.json().blockers.map((b) => b.reason).join('\n');
  assert.match(reasons, new RegExp(`基线运行 #${runC.id} 不可作为发布依据`));
  assert.match(reasons, /映射.*已变更/);

  // 重新打开方案：运行链、差异结论、不可作基线原因都在
  const detail = (await app.inject({ method: 'GET', url: `/api/plans/${planId}` })).json();
  assert.equal(detail.baseline_run.id, runC.id);
  assert.equal(detail.baseline_validity.valid, false);
  assert.ok(detail.baseline_validity.reasons.some((r) => r.includes('映射')));
  assert.ok(detail.run_chain.length >= 5, '运行链应包含历史全部运行');
  const cancelled = detail.run_chain.find((r) => r.status === 'cancelled');
  assert.ok(cancelled, '运行链中应保留已取消运行');
  assert.ok(cancelled.baseline_eligibility.reasons.some((r) => r.includes('cancelled')));
  const failedRun = detail.run_chain.find((r) => r.status === 'failed');
  assert.ok(failedRun.baseline_eligibility.reasons.length > 0);

  // 新一轮完整运行 + 重新 build + 清掉长链失败条目 → 闸门放行
  await removeInput(K.chain); // 长链条目下线（映射再次变化）
  const runD = await runToEnd();
  assert.equal(runD.status, 'complete');
  const rebuild = await app.inject({ method: 'POST', url: `/api/plans/${planId}/build` });
  assert.equal(rebuild.json().baseline_run_id, runD.id);
  const pub2 = await app.inject({ method: 'POST', url: `/api/plans/${planId}/publish`, payload: {} });
  assert.equal(pub2.statusCode, 200, JSON.stringify(pub2.json()));
  assert.equal(pub2.json().published, true, '完整且兼容的运行才能作为发布依据');
});

test('⑤ 导出报告带运行标识与输入摘要；不兼容对比报告明确拒绝', async () => {
  // 稳定对比报告（① 的两次运行）
  const stable = await app.inject({ method: 'GET', url: `/api/runs/compare/report?base=${runA.id}&head=${runA2.id}` });
  assert.equal(stable.statusCode, 200);
  assert.match(stable.headers['content-type'], /text\/markdown/);
  assert.match(stable.body, new RegExp(`运行 #${runA.id}`));
  assert.match(stable.body, new RegExp(`运行 #${runA2.id}`));
  assert.match(stable.body, /映射版本/);
  assert.match(stable.body, /策略版本/);
  assert.match(stable.body, /无业务变化/);

  // 不兼容对比报告（④ 的两次运行）
  const incompat = await app.inject({ method: 'GET', url: `/api/runs/compare/report?base=${runB.id}&head=${runC.id}` });
  assert.match(incompat.body, /输入不兼容/);
  assert.match(incompat.body, /不能作为新方案的放行依据/);

  // 单运行证据报告：运行标识 + 输入摘要 + 冻结逐跳链
  const single = await app.inject({ method: 'GET', url: `/api/runs/${runA.id}/report` });
  assert.match(single.body, new RegExp(`运行 #${runA.id}`));
  assert.match(single.body, new RegExp(runA.mapping_version));
  assert.match(single.body, /重定向环/);
});

test('进程中断时仍在 running 的运行被标记 failed（不冒充完整）', async () => {
  const { rows } = await pool.query(
    `INSERT INTO verification_runs (mapping_version, mapping_snapshot, policy_version, policy_snapshot)
     VALUES ('dead-map', '[]', 'dead-policy', '{}') RETURNING id`);
  const n = await markInterruptedRuns();
  assert.ok(n >= 1);
  const dead = await getRun(rows[0].id);
  assert.equal(dead.status, 'failed');
  assert.ok(dead.diagnostics.some((d) => d.includes('中断')));
  await pool.query('DELETE FROM verification_runs WHERE id=$1', [rows[0].id]);
});
