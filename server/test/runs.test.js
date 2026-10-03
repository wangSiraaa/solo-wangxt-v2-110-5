/**
 * 版本化运行历史验收测试（独立数据库 url_migration_test + 独立站点端口 4578）：
 *  ① 同一映射和策略连续两次完整验证 → 稳定比较，无业务变化；
 *  ② 修复重定向环后，新运行只把相应入口列为已修复，旧运行逐跳证据仍可回看；
 *  ③ 运行中取消 / 本地站点超时 → 运行不完整，基线不被顶替；
 *  ④ 映射或策略变化 → 比较明确提示输入不兼容，旧 run 不能放行新方案；
 *  ⑤ 运行链、差异结论、不可作为基线的原因都可经 API 重新读取（刷新/导出/再打开）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGDATABASE = 'url_migration_test';
process.env.FIXTURE_PORT = '4578';

const { config, fixtureOrigin } = await import('../src/config.js');
const { ensureDatabase, pool } = await import('../src/db.js');
const { startFixture } = await import('../src/fixture.js');
const { seed } = await import('../src/seed.js');
const { runVerification, requestCancel } = await import('../src/verify-runner.js');
const {
  getBaselineRun, compareRuns, diffVerdicts, getRunHops, getRun,
} = await import('../src/run-store.js');
const { recomputeMappings } = await import('../src/mappings-service.js');
const { normalize } = await import('../src/normalize.js');

const O = fixtureOrigin();
let fixture;

before(async () => {
  fixture = await startFixture();
  await ensureDatabase();
  await seed();
});

after(async () => {
  await fixture?.close();
  await pool.end();
});

// 运行 id 在测试间共享（顺序执行）
const R = {};

test('① 同一映射和策略连续两次完整验证：稳定比较，无业务变化', async () => {
  const r1 = await runVerification();
  const r2 = await runVerification();
  R.one = r1.run.id;
  R.two = r2.run.id;
  assert.equal(r1.status, 'complete');
  assert.equal(r2.status, 'complete');
  assert.equal(r1.run.mapping_fingerprint, r2.run.mapping_fingerprint);
  assert.equal(r1.run.policy_fingerprint, r2.run.policy_fingerprint);

  const cmp = await compareRuns(R.one, R.two);
  assert.equal(cmp.compatible, true);
  assert.equal(cmp.summary.new_failures, 0);
  assert.equal(cmp.summary.fixed, 0);
  assert.equal(cmp.summary.regressed, 0);
  assert.equal(cmp.summary.changed, 0);
  assert.equal(cmp.summary.incomparable, 0);
  assert.equal(cmp.summary.unchanged, 9, '9 个归一化键全部无业务变化');

  const baseline = await getBaselineRun();
  assert.equal(baseline.run.id, R.two, '最近一次完整兼容运行是基线');
});

test('② 站点侧修复重定向环（映射不变）：新运行只把相应入口列为已修复，旧证据可回看', async () => {
  // 修复前：/loop/a 的逐跳链（含 loop-repeat）已冻结在运行 #R.two 中
  const loopKey = normalize(`${O}/loop/a`).normKey;
  const beforeHops = await getRunHops(R.two, loopKey);
  assert.ok(beforeHops.length >= 2, '修复前的环证据已冻结');

  await fixture.close();
  process.env.FIXTURE_MODE = 'fixed'; // 模拟运维已上线修复配置（环打断、长链直跳）
  fixture = await startFixture();

  const r3 = await runVerification();
  R.three = r3.run.id;
  assert.equal(r3.status, 'complete');
  assert.equal(r3.run.mapping_fingerprint, (await getRun(R.two)).mapping_fingerprint,
    '站点侧修复不改变输入指纹，两次运行可比较');

  const cmp = await compareRuns(R.two, R.three);
  assert.equal(cmp.compatible, true);
  const fixedKeys = cmp.diff.fixed.map((x) => x.source_norm).sort();
  assert.deepEqual(fixedKeys, [
    normalize(`${O}/chain/0`).normKey,
    normalize(`${O}/loop/a`).normKey,
  ], '只有长链与环两个入口列为已修复');
  assert.equal(cmp.summary.new_failures, 0);
  assert.equal(cmp.summary.regressed, 0);
  // 与修复无关的入口（如中文路径）仍然无变化
  const zhKey = normalize(`${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_source=weibo&utm_campaign=autumn`).normKey;
  assert.ok(cmp.diff.unchanged.some((x) => x.source_norm === zhKey));

  // 旧运行（修复前）的逐跳证据仍然完整可回看
  const oldHops = await getRunHops(R.two, loopKey);
  assert.ok(oldHops.some((h) => h.url_norm.endsWith('/loop/b')), '旧运行的环上证据仍在');
  const newHops = await getRunHops(R.three, loopKey);
  assert.ok(newHops.some((h) => h.location_norm?.endsWith('/articles/tech/42')), '新运行直跳证据');
});

test('③a 运行中取消：运行被标为 cancelled，基线不被顶替', async () => {
  config.verify.stepDelayMs = 150;
  const p = runVerification();
  // 等运行登记为 running 后请求取消
  let running = null;
  for (let i = 0; i < 100 && !running; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const { rows } = await pool.query(
      "SELECT id FROM verification_runs WHERE status='running' ORDER BY id DESC LIMIT 1");
    running = rows[0];
  }
  assert.ok(running, '运行已登记');
  requestCancel(running.id);
  const r = await p;
  config.verify.stepDelayMs = 0;

  assert.equal(r.status, 'cancelled');
  assert.ok(r.results.length < 9, '取消时只处理了一部分入口');
  assert.ok(r.diagnostics.some((d) => d.level === 'cancel' && /取消/.test(d.message)));

  const run = await getRun(running.id);
  assert.equal(run.status, 'cancelled');
  assert.ok(run.finished_at, '终态有结束时间');

  // 基线仍是上一个完整运行 #R.three，取消的运行不顶替
  const baseline = await getBaselineRun();
  assert.equal(baseline.run.id, R.three);
  // 当前基线表仍全部指向完整运行
  const { rows } = await pool.query('SELECT DISTINCT run_id FROM verification_verdicts');
  assert.deepEqual(rows.map((x) => x.run_id), [R.three]);
});

test('③b 本地站点超时：运行标为 failed 并保留诊断，基线不变', async () => {
  await fixture.close();
  // 永不响应的“站点”，强制每跳超时
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(config.fixture.port, '127.0.0.1', r));
  const oldTimeout = config.crawl.timeoutMs;
  config.crawl.timeoutMs = 200;

  const r = await runVerification();

  config.crawl.timeoutMs = oldTimeout;
  await new Promise((res) => hang.close(res));
  fixture = await startFixture(); // 恢复站点（fixed 模式）

  assert.equal(r.status, 'failed');
  assert.ok(r.diagnostics.some((d) => d.level === 'fatal' && /网络级失败/.test(d.message)));
  const run = await getRun(r.run.id);
  assert.equal(run.status, 'failed');
  // 失败运行的逐跳诊断仍保留（超时的 fetch_error）
  const anyKey = r.results.find((x) => x.verdict === 'fetch_error')?.source_norm;
  assert.ok(anyKey, '有 fetch_error 裁决');
  const hops = await getRunHops(run.id, anyKey);
  assert.ok(hops.some((h) => h.fetch_error), '超时证据留在该运行名下');

  const baseline = await getBaselineRun();
  assert.equal(baseline.run.id, R.three, '超时运行不顶替完整基线');
  const { rows } = await pool.query('SELECT DISTINCT run_id FROM verification_verdicts');
  assert.deepEqual(rows.map((x) => x.run_id), [R.three], '基线表未被失败运行污染');
});

test('④ 映射变化后：比较明确提示输入不兼容，旧 run 不能放行新方案', async () => {
  // 业务整改：裁决歧义、剔除错误录入与非本站地址（同 remediate.js）
  await pool.query('DELETE FROM mapping_inputs WHERE target_norm=$1',
    [normalize(`${O}/articles/999`).normKey]);
  await pool.query('DELETE FROM mapping_inputs WHERE source_norm=$1',
    [normalize(`${O}/News/123`).normKey]);
  await pool.query("DELETE FROM mapping_inputs WHERE source_raw LIKE 'http://example.com%'");
  await recomputeMappings(pool);

  // 映射已变、尚未重跑：没有兼容基线
  let baseline = await getBaselineRun();
  assert.equal(baseline.run, null);
  assert.ok(baseline.reasons.some((x) => /映射/.test(x)), '原因指明映射版本变化');

  const r5 = await runVerification();
  R.five = r5.run.id;
  assert.equal(r5.status, 'complete');
  assert.equal(r5.results.every((x) => x.verdict === 'ok' || x.verdict === 'deleted_gone_ok'), true);

  // 新旧运行指纹不同 → 不可比较，并说明原因
  const cmp = await compareRuns(R.three, R.five);
  assert.equal(cmp.compatible, false);
  assert.ok(cmp.reasons.some((x) => /输入映射版本不同/.test(x)));

  baseline = await getBaselineRun();
  assert.equal(baseline.run.id, R.five, '新完整运行成为当前基线');
});

test('④b 发布闸门：基线运行可用则放行；映射再变则旧 run 不能放行', async () => {
  const { default: apiRoutes } = await import('../src/routes.js');
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  await app.register(apiRoutes);

  const plan = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: '验收方案-可发布' } });
  const planId = plan.json().id;
  await app.inject({ method: 'POST', url: `/api/plans/${planId}/build` });
  const ok = await app.inject({ method: 'POST', url: `/api/plans/${planId}/publish` });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().published, true);
  assert.equal(ok.json().baseline_run_id, R.five, '发布依据为当前基线运行');

  // 映射再次变化（新增一条录入），但不重新验证
  const s = normalize(`${O}/files%2Fdraft`);
  await pool.query(
    `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
     VALUES ($1,$2,$3,$4,'manual','验收：映射变化后旧运行不得放行')`,
    [`${O}/files%2Fdraft`, s.normKey, `${O}/files%2Fdraft`, s.normKey]);
  await recomputeMappings(pool);

  const plan2 = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: '验收方案-应被拒' } });
  const plan2Id = plan2.json().id;
  await app.inject({ method: 'POST', url: `/api/plans/${plan2Id}/build` });
  const denied = await app.inject({ method: 'POST', url: `/api/plans/${plan2Id}/publish` });
  assert.equal(denied.statusCode, 409);
  assert.ok(
    denied.json().blockers.some((b) => /无可用基线运行/.test(b.reason) && /映射/.test(b.reason)),
    '拒绝原因明确：映射变化后无兼容基线',
  );
  await app.close();
});

test('④c 策略变化后：旧运行同样失去基线资格', async () => {
  const r6 = await runVerification(); // 让当前映射先有一个完整基线
  assert.equal(r6.status, 'complete');
  let baseline = await getBaselineRun();
  assert.equal(baseline.run.id, r6.run.id);

  config.rules.tailSlashMode = 'ignore'; // 策略变化
  baseline = await getBaselineRun();
  assert.equal(baseline.run, null);
  assert.ok(baseline.reasons.some((x) => /策略/.test(x)), '原因指明策略变化');
  const cmp = await compareRuns(r6.run.id, r6.run.id); // 自身与自身仍兼容
  assert.equal(cmp.compatible, true);
  config.rules.tailSlashMode = 'keep';

  baseline = await getBaselineRun();
  assert.equal(baseline.run.id, r6.run.id, '策略还原后基线资格恢复');
});

test('⑤ 运行链 / 差异结论 / 基线原因均可经 API 重新读取，导出报告带运行标识与输入摘要', async () => {
  const { default: apiRoutes } = await import('../src/routes.js');
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  await app.register(apiRoutes);

  // 运行列表：每次运行的指纹、终态、兼容性、基线标记
  const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json();
  assert.ok(list.baseline_run_id, '有当前基线');
  const cancelled = list.runs.find((r) => r.status === 'cancelled');
  assert.ok(cancelled, '取消的运行仍在历史中');
  assert.equal(cancelled.is_baseline, false);

  // 单次运行详情：含“为什么不能作为基线”
  const detail = (await app.inject({ method: 'GET', url: `/api/runs/${cancelled.id}` })).json();
  assert.equal(detail.baseline_eligible, false);
  assert.ok(detail.diagnostics.length > 0, '取消诊断可回看');

  // 旧运行逐跳证据可回看
  const loopKey = normalize(`${O}/loop/a`).normKey;
  const hopsRes = await app.inject({ method: 'GET', url: `/api/runs/${R.two}/crawl/${encodeURIComponent(loopKey)}` });
  assert.equal(hopsRes.statusCode, 200);
  assert.ok(hopsRes.json().length >= 2);

  // 稳定比较结论可重新获取
  const cmp = (await app.inject({ method: 'GET', url: `/api/runs/compare?a=${R.one}&b=${R.two}` })).json();
  assert.equal(cmp.compatible, true);
  assert.equal(cmp.summary.unchanged, 9);

  // 导出：单运行报告带运行标识与输入摘要
  const report = await app.inject({ method: 'GET', url: `/api/runs/${R.two}/report` });
  assert.match(report.headers['content-type'], /text\/markdown/);
  assert.match(report.body, new RegExp(`运行编号：\\*\\*#${R.two}\\*\\*`));
  assert.match(report.body, /映射指纹/);
  assert.match(report.body, /策略指纹/);
  assert.match(report.body, /输入摘要/);

  // 导出：比较报告带两次运行标识；不兼容比较也有明确结论
  const cmpReport = await app.inject({ method: 'GET', url: `/api/runs/compare/report?a=${R.three}&b=${R.five}` });
  assert.match(cmpReport.body, /输入不兼容/);
  assert.match(cmpReport.body, new RegExp(`#${R.three}`));
  assert.match(cmpReport.body, new RegExp(`#${R.five}`));
  await app.close();
});

test('diffVerdicts 纯函数：不可比较项与状态回退分类正确', () => {
  const a = [
    { source_norm: 'k1', source_raw: 'r1', verdict: 'ok', final_status: 200, final_url_norm: 'u1', hops: 1 },
    { source_norm: 'k2', source_raw: 'r2', verdict: 'redirect_loop', final_status: null, final_url_norm: null, hops: 6 },
    { source_norm: 'k3', source_raw: 'r3', verdict: 'ok', final_status: 200, final_url_norm: 'u3', hops: 1 },
  ];
  const b = [
    { source_norm: 'k1', source_raw: 'r1', verdict: 'ok', final_status: 200, final_url_norm: 'u1', hops: 1 },
    { source_norm: 'k2', source_raw: 'r2', verdict: 'chain_too_long', final_status: null, final_url_norm: null, hops: 6 },
    { source_norm: 'k4', source_raw: 'r4', verdict: 'ok', final_status: 200, final_url_norm: 'u4', hops: 1 },
  ];
  const d = diffVerdicts(a, b);
  assert.equal(d.unchanged.length, 1);
  assert.equal(d.regressed.length, 1, '环→长链：两次都失败但形态变化 = 状态回退');
  assert.equal(d.incomparable.length, 2, 'k3 只在 A、k4 只在 B');
});
