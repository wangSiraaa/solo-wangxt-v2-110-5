/**
 * 验证运行引擎：每次运行冻结输入（映射快照 + 策略快照 + 选择范围），
 * 对快照内每条映射真实请求本地站点，逐跳证据与裁决写入 run_items（历史不可改）。
 *
 * 终态语义：
 *  - complete：全部条目正常结束；scope=all 时推进当前证据基线
 *    （verification_verdicts / crawl_results 只被完整全量运行替换）；
 *  - failed：预检失败（站点不可达）、连续网络错误/超时、或异常中断——
 *    诊断保留在 run.diagnostics，已完成的条目证据保留，但绝不替换基线；
 *  - cancelled：运行中被取消，同上。
 */
import { pool } from './db.js';
import { normalize } from './normalize.js';
import { judge, probeSite } from './verifier.js';
import {
  getRun, getRunItems, snapshotMappingVersion, snapshotPolicyVersion,
} from './run-service.js';

const VERDICT_LABEL = {
  ok: '通过',
  redirect_loop: '重定向环',
  chain_too_long: '跳转链过长',
  fetch_error: '请求被拒/失败',
  deleted_gone_ok: '已删除-状态正确',
  deleted_not_gone: '已删除但未消亡',
  ambiguity: '归一化歧义',
  final_status_bad: '最终页状态异常',
};

/** 连续多少个条目发生网络层错误/超时即判定站点故障、中止运行 */
const NETWORK_FAILURE_ABORT_THRESHOLD = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 启动一次验证运行（后台执行，立即返回运行记录）。
 * @param {string[]|null} onlyKeys 指定归一化键子集；null = 全量
 * @param {number} itemDelayMs   每条目间人为延迟（演示/测试取消用）
 */
export async function startRun({ onlyKeys = null, itemDelayMs = 0 } = {}) {
  const { rows: running } = await pool.query(
    `SELECT id FROM verification_runs WHERE status='running'`);
  if (running.length) {
    const e = new Error(`运行 #${running[0].id} 仍在进行中，不能并发启动新运行`);
    e.statusCode = 409;
    throw e;
  }

  const m = await snapshotMappingVersion();
  const p = snapshotPolicyVersion();
  const scope = onlyKeys?.length ? 'selected' : 'all';
  const snapshot = scope === 'all'
    ? m.snapshot
    : m.snapshot.filter((r) => onlyKeys.includes(r.source_norm));

  const { rows } = await pool.query(
    `INSERT INTO verification_runs
       (scope, scope_keys, mapping_version, mapping_count, conflicted_count,
        mapping_snapshot, policy_version, policy_snapshot, fixture_mode, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [scope, scope === 'selected' ? JSON.stringify(onlyKeys) : null,
     m.version, m.count, m.conflicted, JSON.stringify(snapshot),
     p.version, JSON.stringify(p.snapshot),
     process.env.FIXTURE_MODE || 'default', snapshot.length]);
  const run = rows[0];

  // 后台执行；任何未捕获异常都收敛为 failed 终态（仅限仍在 running 的运行，
  // 已入终态的运行——例如推进基线失败——只追加诊断，不改状态）
  executeRun(run.id, { itemDelayMs }).catch(async (err) => {
    await appendDiagnostics(run.id, [`运行异常中断：${err.message}`]).catch(() => {});
    await pool.query(
      `UPDATE verification_runs SET status='failed', finished_at=now()
        WHERE id=$1 AND status='running'`, [run.id]).catch(() => {});
  });
  return run;
}

export async function cancelRun(runId) {
  const { rowCount } = await pool.query(
    `UPDATE verification_runs SET cancel_requested=true
      WHERE id=$1 AND status='running'`, [runId]);
  return rowCount > 0;
}

/** 轮询直到终态（CLI / 测试用） */
export async function waitForRun(runId, { timeoutMs = 60000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== 'running') return run;
    if (Date.now() > deadline) throw new Error(`waitForRun ${runId} timeout`);
    await sleep(intervalMs);
  }
}

async function appendDiagnostics(runId, messages) {
  await pool.query(
    `UPDATE verification_runs
        SET diagnostics = diagnostics || $2::jsonb WHERE id=$1`,
    [runId, JSON.stringify(messages)]);
}

async function finalizeRun(runId, status) {
  await pool.query(
    `UPDATE verification_runs SET status=$2, finished_at=now() WHERE id=$1`,
    [runId, status]);
}

async function executeRun(runId, { itemDelayMs = 0 } = {}) {
  const run = await getRun(runId);
  const mappings = run.mapping_snapshot; // 冻结的输入快照，运行期间不读 live 表
  const diag = (msgs) => appendDiagnostics(runId, Array.isArray(msgs) ? msgs : [msgs]);

  // 预检：站点整体不可达时不开始逐条验证（避免整轮 fetch_error 污染证据）
  const probe = await probeSite();
  if (!probe.ok) {
    await diag(`本地站点预检失败：${probe.error}。未发起任何条目验证；运行标记 failed，基线保持不变`);
    await finalizeRun(runId, 'failed');
    return;
  }

  let done = 0;
  let failed = 0;
  let consecutiveNetFail = 0;

  for (const m of mappings) {
    // 条目间检查取消请求（取消是协作式的：当前条目完成后停下）
    const { rows: flag } = await pool.query(
      'SELECT cancel_requested FROM verification_runs WHERE id=$1', [runId]);
    if (flag[0]?.cancel_requested) {
      await diag(`运行被取消（已完成 ${done}/${mappings.length} 条）；已完成条目证据保留，运行标记 cancelled，基线保持不变`);
      await finalizeRun(runId, 'cancelled');
      return;
    }
    if (itemDelayMs) await sleep(itemDelayMs);

    let item;
    let networkFailure = false;
    try {
      item = await verifyOne(m);
      networkFailure = item.networkFailure;
    } catch (e) {
      item = {
        source_norm: m.source_norm, source_raw: m.source_raw,
        mapping_type: m.mapping_type, target_norm: m.target_norm,
        item_status: 'error', verdict: null,
        issues: [`条目执行异常：${e.message}`],
        final: {}, hops: 0, tracker: null, hopsDetail: [],
      };
      networkFailure = false;
    }
    await insertRunItem(runId, item);
    done++;
    if (item.verdict && !['ok', 'deleted_gone_ok'].includes(item.verdict)) failed++;
    await pool.query(
      'UPDATE verification_runs SET done_count=$2, fail_count=$3 WHERE id=$1',
      [runId, done, failed]);

    // 连续网络错误/超时 → 判定站点故障，中止（局部失败保留诊断，不冒充成功）
    consecutiveNetFail = networkFailure ? consecutiveNetFail + 1 : 0;
    if (consecutiveNetFail >= NETWORK_FAILURE_ABORT_THRESHOLD) {
      await diag(
        `连续 ${NETWORK_FAILURE_ABORT_THRESHOLD} 个条目发生网络错误/超时，判定本地站点故障；` +
        `运行中止（已完成 ${done}/${mappings.length} 条），标记 failed，基线保持不变`);
      await finalizeRun(runId, 'failed');
      return;
    }
  }

  await finalizeRun(runId, 'complete');
  // 只有完整全量运行才推进当前证据基线；局部范围运行只留历史。
  // 推进失败不影响运行本身的 complete 终态（证据已在 run_items 中冻结）。
  if (run.scope === 'all') {
    try {
      await promoteRun(runId);
    } catch (e) {
      await diag(`基线推进失败：${e.message}（运行证据完整保留，可人工复核后重跑）`);
    }
  }
}

/** 单条映射验证（歧义键不请求，直接判 ambiguity） */
async function verifyOne(m) {
  if (m.status === 'conflicted') {
    const { rows: amb } = await pool.query(
      'SELECT source_forms, targets FROM mapping_ambiguities WHERE source_norm=$1',
      [m.source_norm]);
    const issues = [
      `同归一化键 ${m.source_norm} 有多个不同目标`,
      ...(amb[0]?.targets ?? []).map((t) => `候选目标: ${t}`),
    ];
    return {
      source_norm: m.source_norm, source_raw: m.source_raw,
      mapping_type: m.mapping_type, target_norm: m.target_norm,
      item_status: 'done', verdict: 'ambiguity', issues,
      final: {}, hops: 0, tracker: null, hopsDetail: [], networkFailure: false,
    };
  }

  const t = normalize(m.target_raw);
  const { verdict, issues, crawl, tracker } = await judge(m.source_raw, m.mapping_type, t.normKey);
  const hopsDetail = crawl.hops.map((h) => ({
    index: h.index, url_raw: h.url_raw, url_norm: h.url_norm,
    status: h.status ?? null, location_raw: h.location_raw ?? null,
    location_norm: h.location_norm ?? null, is_redirect: h.is_redirect,
    fetch_error: h.fetch_error ?? null, note: h.note ?? null,
  }));
  return {
    source_norm: m.source_norm, source_raw: m.source_raw,
    mapping_type: m.mapping_type, target_norm: m.target_norm,
    item_status: 'done', verdict, issues,
    final: { raw: crawl.finalRaw, norm: crawl.finalNorm, status: crawl.finalStatus },
    hops: crawl.hops.length, tracker, hopsDetail,
    // 网络层失败（连接错误/超时）区别于白名单拒绝（根本没发请求）
    networkFailure: hopsDetail.some((h) => h.fetch_error != null),
  };
}

async function insertRunItem(runId, it) {
  await pool.query(
    `INSERT INTO run_items
       (run_id, source_norm, source_raw, mapping_type, target_norm, item_status,
        verdict, issues, final_url_raw, final_url_norm, final_status,
        hops, tracker_preserved, hops_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (run_id, source_norm) DO NOTHING`,
    [runId, it.source_norm, it.source_raw, it.mapping_type ?? null, it.target_norm ?? null,
     it.item_status, it.verdict ?? null, JSON.stringify(it.issues ?? []),
     it.final?.raw ?? null, it.final?.norm ?? null, it.final?.status ?? null,
     it.hops ?? 0, it.tracker ? it.tracker.ok : null,
     JSON.stringify(it.hopsDetail ?? [])]);
}

/**
 * 推进基线：用一次完整全量运行的结果整体替换当前证据表。
 * failed / cancelled / 局部运行永远不会走到这里——最后一个完整基线 thus 保留。
 */
async function promoteRun(runId) {
  const items = await getRunItems(runId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM verification_verdicts');
    await client.query('DELETE FROM crawl_results');
    for (const it of items) {
      if (it.item_status !== 'done' || !it.verdict) continue;
      await client.query(
        `INSERT INTO verification_verdicts
           (source_norm, source_raw, final_url_raw, final_url_norm, final_status,
            hops, tracker_preserved, verdict, issues, verified_at, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
        [it.source_norm, it.source_raw, it.final_url_raw, it.final_url_norm,
         it.final_status, it.hops, it.tracker_preserved, it.verdict,
         JSON.stringify(it.issues ?? []), runId]);
      for (const h of it.hops_detail ?? []) {
        await client.query(
          `INSERT INTO crawl_results
             (source_norm, hop_index, url_raw, url_norm, status_code,
              location_raw, location_norm, is_redirect, fetch_error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [it.source_norm, h.index, h.url_raw, h.url_norm, h.status,
           h.location_raw ?? null, h.location_norm ?? null, h.is_redirect,
           h.fetch_error ?? null]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export { VERDICT_LABEL, getRun, getRunItems };
