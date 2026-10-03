/** REST API：映射录入、规范化试算、版本化验证运行、运行对比、迁移方案与发布闸门。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings } from './mappings-service.js';
import { startRun, waitForRun, cancelRun, VERDICT_LABEL } from './verify-runner.js';
import {
  getRun, getRunItems, listRuns, currentBaseline, currentVersions,
  baselineEligibility, compareRuns, comparisonReportMd, runReportMd,
  summarizeRun, STATUS_LABEL,
} from './run-service.js';
import { config } from './config.js';

export default async function api(app) {
  const toId = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => config.rules);

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const r = normalize(String(u));
      if (!r.ok) return { input: u, ok: false, error: r.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: r.normKey,
        pathname: r.pathname,
        identity_query: r.identityQuery,
        tracker_params: [...trackers.keys()],
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决（来自当前基线运行）
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at, v.run_id
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return { inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL };
  });

  // 录入一条原始映射：只进 mapping_inputs；随后重算 url_mappings 状态
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      await recomputeMappings(client);
      await client.query('COMMIT');
      return { ok: true, source_norm: s.normKey, target_norm: t.normKey };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // ---- 版本化验证运行 -------------------------------------------------

  // 运行历史：每次运行冻结映射版本、策略版本、选择范围与终态
  app.get('/api/runs', async () => ({
    runs: await listRuns(),
    statusLabel: STATUS_LABEL,
    verdictLabel: VERDICT_LABEL,
  }));

  // 启动一次运行（后台执行）。body: { source_norm?: string, item_delay_ms?: number }
  app.post('/api/runs', async (req, reply) => {
    const onlyKey = req.body?.source_norm ?? null;
    const delay = Math.min(Number(req.body?.item_delay_ms ?? 0) || 0, 2000);
    try {
      const run = await startRun({
        onlyKeys: onlyKey ? [onlyKey] : null,
        itemDelayMs: delay,
      });
      return summarizeRun(run);
    } catch (e) {
      if (e.statusCode === 409) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  // 兼容入口：同步等待一次运行结束（CLI 风格）
  app.post('/api/verify', async (req, reply) => {
    const onlyKey = req.body?.source_norm ?? null;
    let run;
    try {
      run = await startRun({ onlyKeys: onlyKey ? [onlyKey] : null });
    } catch (e) {
      if (e.statusCode === 409) return reply.code(409).send({ error: e.message });
      throw e;
    }
    const final = await waitForRun(run.id);
    const items = await getRunItems(run.id);
    return {
      run_id: run.id,
      status: final.status,
      status_label: STATUS_LABEL[final.status],
      diagnostics: final.diagnostics,
      count: items.length,
      results: items.map((i) => ({
        source_norm: i.source_norm, verdict: i.verdict,
        issues: i.issues, hops: i.hops,
      })),
      label: VERDICT_LABEL,
    };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const id = toId(req.params.id);
    const run = id && (await getRun(id));
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const items = await getRunItems(run.id);
    const cur = await currentVersions();
    const baseline = await currentBaseline();
    return {
      run: {
        ...summarizeRun(run),
        is_current_baseline: baseline?.id === run.id,
        baseline_eligibility: baselineEligibility(run, cur),
      },
      items,
      verdictLabel: VERDICT_LABEL,
    };
  });

  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const ok = await cancelRun(Number(req.params.id));
    if (!ok) return reply.code(409).send({ error: '运行不在进行中，无法取消' });
    return { cancelled: true };
  });

  // 某次运行中某入口的冻结逐跳链（历史证据，不随新运行覆盖）
  app.get('/api/runs/:id/hops/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT hops_detail, verdict, issues FROM run_items WHERE run_id=$1 AND source_norm=$2',
      [req.params.id, key]);
    if (!rows.length) return reply.code(404).send({ error: '该运行中无此入口证据' });
    return rows[0];
  });

  // 运行对比：只有映射版本与策略版本都一致才给出业务差异
  app.post('/api/runs/compare', async (req, reply) => {
    const baseId = Number(req.body?.base_id);
    const headId = Number(req.body?.head_id);
    if (!baseId || !headId) return reply.code(400).send({ error: 'base_id 与 head_id 必填' });
    const cmp = await compareRuns(baseId, headId);
    if (!cmp) return reply.code(404).send({ error: 'run not found' });
    return cmp;
  });

  // 导出：单运行证据报告 / 对比报告（Markdown，带运行标识与输入摘要）
  app.get('/api/runs/:id/report', async (req, reply) => {
    const id = toId(req.params.id);
    const run = id && (await getRun(id));
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const items = await getRunItems(run.id);
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="run-${run.id}-report.md"`);
    return runReportMd(run, items);
  });

  app.get('/api/runs/compare/report', async (req, reply) => {
    const baseId = toId(req.query.base);
    const headId = toId(req.query.head);
    if (!baseId || !headId) return reply.code(400).send({ error: 'base 与 head 必填且为运行编号' });
    const cmp = await compareRuns(baseId, headId);
    if (!cmp) return reply.code(404).send({ error: 'run not found' });
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition',
      `attachment; filename="run-${baseId}-vs-${headId}.md"`);
    return comparisonReportMd(cmp);
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending')  AS pending
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO migration_plans (name) VALUES ($1)
         RETURNING *`, [name]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    }
  });

  // 把全部 active 映射纳入方案；证据取自当前基线运行（完整+兼容的全量运行）
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
    const baseline = await currentBaseline();
    const baselineItems = new Map();
    if (baseline) {
      for (const it of await getRunItems(baseline.id)) baselineItems.set(it.source_norm, it);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
      if (!plan.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'plan not found' }); }
      if (plan[0].status === 'published') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: '已发布方案不可改' });
      }
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const { rows: ms } = await client.query(
        `SELECT * FROM url_mappings WHERE status='active' ORDER BY id`);
      for (const m of ms) {
        const ev = baselineItems.get(m.source_norm) ?? null;
        const good = ev && (ev.verdict === 'ok' || ev.verdict === 'deleted_gone_ok');
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           good ? 'verified' : ev?.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             run_id: ev?.run_id ?? null,
             verdict: ev?.verdict ?? null,
             issues: ev?.issues ?? [],
             final_status: ev?.final_status ?? null,
             final_url: ev?.final_url_raw ?? null,
             hops: ev?.hops ?? 0,
             tracker_preserved: ev?.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
           })]);
      }
      await client.query(
        'UPDATE migration_plans SET baseline_run_id=$2 WHERE id=$1',
        [planId, baseline?.id ?? null]);
      await client.query('COMMIT');
      return {
        built: ms.length,
        baseline_run_id: baseline?.id ?? null,
        warning: baseline ? null : '当前没有完整且兼容的全量验证运行，所有条目仅为 pending',
      };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const plan = plans[0];
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);

    // 基线运行复核：为什么能/不能作为发布依据（刷新、重开都看得到）
    const cur = await currentVersions();
    const baseline = await currentBaseline();
    let baselineRun = null;
    let baselineValidity = { valid: false, reasons: ['方案尚未构建（无基线运行）'] };
    if (plan.baseline_run_id) {
      const run = await getRun(plan.baseline_run_id);
      if (run) {
        const elig = baselineEligibility(run, cur);
        const reasons = [...elig.reasons];
        if (elig.eligible && baseline?.id !== run.id) {
          reasons.push(`存在更新的完整兼容运行 #${baseline.id}，请重新 build 方案`);
        }
        baselineRun = {
          ...summarizeRun(run),
          is_current_baseline: baseline?.id === run.id,
        };
        baselineValidity = { valid: reasons.length === 0, reasons };
      } else {
        baselineValidity = { valid: false, reasons: [`基线运行 #${plan.baseline_run_id} 已不存在`] };
      }
    }
    const runChain = await listRuns(20);
    return {
      plan, items,
      baseline_run: baselineRun,
      baseline_validity: baselineValidity,
      current_baseline_id: baseline?.id ?? null,
      run_chain: runChain,
    };
  });

  /**
   * 发布闸门：
   *  - 方案必须基于一个基线运行构建，且该运行现在仍然 complete、全量、
   *    与当前映射/策略版本兼容（旧运行不能给新映射/新策略放行）；
   *  - 该运行必须仍是当前基线（存在更新完整运行时需重新 build）；
   *  - 不存在 blocked/pending 条目（每条都必须有成功验证的证据）；
   *  - 不存在未纳入方案的 active 映射；
   *  - 不存在 conflicted 映射。
   * 任何一条不满足都拒绝发布并列出受影响链接。
   */
  app.post('/api/plans/:id/publish', async (req, reply) => {
    const planId = Number(req.params.id);
    const blockers = [];

    const { rows: plan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
    if (!plan.length) return reply.code(404).send({ error: 'not found' });
    if (plan[0].status === 'published') {
      return { alreadyPublished: true, plan: plan[0] };
    }

    // 基线运行复核（核心：只有完整且与当前映射/策略兼容的运行才能放行）
    const cur = await currentVersions();
    const baseline = await currentBaseline();
    if (!plan[0].baseline_run_id) {
      blockers.push({ source: '（方案级）', reason: '方案未基于任何完整验证运行构建——先执行一次全量验证再 build' });
    } else {
      const run = await getRun(plan[0].baseline_run_id);
      if (!run) {
        blockers.push({ source: '（方案级）', reason: `基线运行 #${plan[0].baseline_run_id} 已不存在` });
      } else {
        for (const r of baselineEligibility(run, cur).reasons) {
          blockers.push({ source: '（方案级）', reason: `基线运行 #${run.id} 不可作为发布依据：${r}` });
        }
        if (baseline && baseline.id !== run.id) {
          blockers.push({
            source: '（方案级）',
            reason: `存在更新的完整兼容运行 #${baseline.id}（方案基于 #${run.id} 构建），请重新 build 方案`,
          });
        }
        if (!baseline) {
          blockers.push({ source: '（方案级）', reason: '当前不存在完整且兼容的验证运行，不能放行' });
        }
      }
    }

    const { rows: badItems } = await pool.query(
      `SELECT m.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有验证证据（填表不等于迁移完成）'
          : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });
}
