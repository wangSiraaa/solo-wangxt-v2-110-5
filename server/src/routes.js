/** REST API：映射录入、规范化试算、验证、版本化运行历史、迁移方案与发布闸门。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings } from './mappings-service.js';
import { runVerification, requestCancel, VERDICT_LABEL } from './verify-runner.js';
import {
  RUN_STATUS_LABEL, currentInputVersion, compatibilityReasons,
  getBaselineRun, getRun, getRunVerdicts, getRunHops,
  compareRuns, buildRunReport, buildCompareReport,
} from './run-store.js';
import { config } from './config.js';

export default async function api(app) {
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

  // 全量材料：原始输入 + 生效映射 + 最新裁决 + 当前基线运行状态
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at, v.run_id
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    const baseline = await getBaselineRun();
    return {
      inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL,
      baseline: {
        run_id: baseline.run?.id ?? null,
        started_at: baseline.run?.started_at ?? null,
        reasons: baseline.reasons,
        current: baseline.current,
      },
    };
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

  app.post('/api/verify', async (req) => {
    const onlyKey = req.body?.source_norm ?? null;
    const r = await runVerification({ onlyKey });
    return { ...r, run_id: r.run.id };
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 版本化运行历史 -------------------------------------------------

  // 运行列表：每次运行冻结的输入版本 + 终态 + 与当前输入的兼容性 + 是否当前基线
  app.get('/api/runs', async () => {
    const baseline = await getBaselineRun();
    const { rows } = await pool.query(
      'SELECT * FROM verification_runs ORDER BY id DESC');
    const cur = baseline.current;
    return {
      current: cur,
      baseline_run_id: baseline.run?.id ?? null,
      baseline_reasons: baseline.reasons,
      statusLabel: RUN_STATUS_LABEL,
      runs: rows.map((r) => ({
        ...r,
        is_baseline: baseline.run?.id === r.id,
        compatible_with_current:
          r.mapping_fingerprint === cur.mappingFingerprint
          && r.policy_fingerprint === cur.policyFingerprint,
        incompatibility_reasons: compatibilityReasons(r, {
          mapping_fingerprint: cur.mappingFingerprint,
          policy_fingerprint: cur.policyFingerprint,
        }),
      })),
    };
  });

  app.get('/api/runs/compare', async (req, reply) => {
    const a = Number(req.query.a);
    const b = Number(req.query.b);
    if (!a || !b) return reply.code(400).send({ error: 'query a=<runId>&b=<runId> required' });
    const cmp = await compareRuns(a, b);
    if (cmp.error) return reply.code(404).send({ error: cmp.error });
    return cmp;
  });

  // 比较报告导出（Markdown，带两次运行的标识与输入摘要）
  app.get('/api/runs/compare/report', async (req, reply) => {
    const a = Number(req.query.a);
    const b = Number(req.query.b);
    if (!a || !b) return reply.code(400).send({ error: 'query a=<runId>&b=<runId> required' });
    const md = await buildCompareReport(a, b);
    if (md == null) return reply.code(404).send({ error: 'run not found' });
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="compare-run-${a}-vs-${b}.md"`)
      .send(md);
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const run = await getRun(Number(req.params.id));
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const cur = await currentInputVersion();
    const baseline = await getBaselineRun();
    return {
      ...run,
      status_label: RUN_STATUS_LABEL[run.status] ?? run.status,
      is_baseline: baseline.run?.id === run.id,
      compatible_with_current:
        run.mapping_fingerprint === cur.mappingFingerprint
        && run.policy_fingerprint === cur.policyFingerprint,
      incompatibility_reasons: compatibilityReasons(run, {
        mapping_fingerprint: cur.mappingFingerprint,
        policy_fingerprint: cur.policyFingerprint,
      }),
      baseline_eligible:
        run.status === 'complete' && run.scope === 'all'
        && run.mapping_fingerprint === cur.mappingFingerprint
        && run.policy_fingerprint === cur.policyFingerprint,
    };
  });

  app.get('/api/runs/:id/verdicts', async (req, reply) => {
    const run = await getRun(Number(req.params.id));
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return getRunVerdicts(run.id);
  });

  // 某次运行中某入口的逐跳链（旧运行证据可回看）
  app.get('/api/runs/:id/crawl/:key', async (req, reply) => {
    const rows = await getRunHops(Number(req.params.id), decodeURIComponent(req.params.key));
    if (!rows.length) return reply.code(404).send({ error: 'no hop evidence for this key in this run' });
    return rows;
  });

  // 取消进行中的运行：已处理入口保留证据，运行被标为 cancelled（不完整）
  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const run = await getRun(Number(req.params.id));
    if (!run) return reply.code(404).send({ error: 'run not found' });
    if (run.status !== 'running') {
      return reply.code(409).send({ error: `运行已处于终态（${run.status}），无法取消` });
    }
    requestCancel(run.id);
    return { cancelling: true, run_id: run.id };
  });

  // 单次运行报告导出（Markdown，带运行标识与输入摘要）
  app.get('/api/runs/:id/report', async (req, reply) => {
    const md = await buildRunReport(Number(req.params.id));
    if (md == null) return reply.code(404).send({ error: 'run not found' });
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="run-${req.params.id}-report.md"`)
      .send(md);
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
    const baseline = await getBaselineRun();
    return {
      plans: rows,
      baseline: {
        run_id: baseline.run?.id ?? null,
        started_at: baseline.run?.started_at ?? null,
        reasons: baseline.reasons,
      },
    };
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

  // 把全部 active 映射纳入方案，并按最新裁决设置条目状态
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
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
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved, v.run_id AS verdict_run_id
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        const good = m.verdict === 'ok' || m.verdict === 'deleted_gone_ok';
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
           good ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             run_id: m.verdict_run_id ?? null,
             proposed_redirect_url: proposed,
           })]);
      }
      await client.query('COMMIT');
      return { built: ms.length };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return { plan: plans[0], items };
  });

  /**
   * 发布闸门：
   *  - 必须存在“完整（complete）+ 全量 + 与当前映射/策略指纹兼容”的基线运行；
   *    映射或策略一旦变化，旧运行立即失去放行资格（409 并说明原因）；
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

    // 运行级闸门：只有完整且与当前输入兼容的基线运行才能作为发布依据
    const baseline = await getBaselineRun();
    if (!baseline.run) {
      for (const r of baseline.reasons) {
        blockers.push({ source: '（发布闸门）', reason: `无可用基线运行：${r}` });
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

    // 条目证据必须来自当前基线运行（防止用旧运行/局部运行的证据蒙混）
    if (baseline.run) {
      const { rows: stale } = await pool.query(
        `SELECT m.source_raw, pi.evidence
           FROM migration_plan_items pi
           JOIN url_mappings m ON m.id=pi.mapping_id
          WHERE pi.plan_id=$1 AND pi.item_status='verified'
            AND (pi.evidence->>'run_id')::bigint IS DISTINCT FROM $2`,
        [planId, baseline.run.id]);
      for (const s of stale) {
        blockers.push({
          source: s.source_raw,
          reason: `证据来自运行 #${s.evidence?.run_id ?? '?'}，不是当前基线运行 #${baseline.run.id}；请重新 build 方案`,
        });
      }
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
      return reply.code(409).send({
        published: false, blockers,
        baseline_run_id: baseline.run?.id ?? null,
      });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0], baseline_run_id: baseline.run.id };
  });
}
