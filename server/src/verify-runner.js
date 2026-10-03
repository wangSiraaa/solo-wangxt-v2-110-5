/**
 * 验证流水线：每次执行都是一个“版本化运行”（verification_runs 一行）：
 *  - 开始时冻结输入映射版本（指纹+摘要）、规范化/白名单策略（指纹+快照）、选择范围；
 *  - 逐跳证据写入 run_crawl_hops、每条裁决写入 run_verdicts（按运行隔离，旧运行可回看）；
 *  - 终态：complete / failed / cancelled。
 *    · 手动取消 → cancelled；
 *    · 任何入口出现网络级失败（超时/连接拒绝等）→ failed（局部失败也算，
 *      因为该运行的证据整体不再可信）；
 *    · 未捕获异常 → failed。
 *  - 只有 complete 运行才更新“当前基线”表（verification_verdicts / crawl_results，
 *    并打上 run_id）；failed / cancelled 运行只保留诊断，绝不顶替上一个完整基线。
 *  - 冲突键不请求，直接判 ambiguity —— 连请求都不应该开始。
 */
import { pool } from './db.js';
import { normalize } from './normalize.js';
import { judge } from './verifier.js';
import { config } from './config.js';
import {
  RUN_STATUS, currentInputVersion, insertRun, finishRun,
} from './run-store.js';

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

/** 进行中的取消请求（run_id 集合）。取消在两条映射之间生效。 */
const cancelRequests = new Set();

export function requestCancel(runId) {
  cancelRequests.add(Number(runId));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runVerification({ onlyKey = null } = {}) {
  const scope = onlyKey ? 'keys' : 'all';
  const input = await currentInputVersion();
  const run = await insertRun({ scope, scopeKeys: onlyKey ? [onlyKey] : [], input });
  const diagnostics = [];
  const results = [];
  let networkFailures = 0;

  const finalize = async (status) => {
    cancelRequests.delete(Number(run.id));
    const totals = {};
    for (const r of results) totals[r.verdict] = (totals[r.verdict] ?? 0) + 1;
    if (networkFailures) totals._network_failures = networkFailures;
    const finished = await finishRun(run.id, status, totals, diagnostics);
    if (status === RUN_STATUS.COMPLETE) await promoteToBaseline(run.id, scope);
    return { run: finished, status, count: results.length, results, diagnostics, label: VERDICT_LABEL };
  };

  try {
    const { rows: mappings } = await pool.query(
      `SELECT m.*,
              (SELECT count(*) FROM mapping_inputs i WHERE i.source_norm = m.source_norm) AS input_count
         FROM url_mappings m ${onlyKey ? 'WHERE m.source_norm = $1' : ''}
         ORDER BY m.id`,
      onlyKey ? [onlyKey] : [],
    );

    for (const m of mappings) {
      // 取消检查放在两条映射之间：已完成的入口保留证据，未处理的明确列出
      if (cancelRequests.has(Number(run.id))) {
        const remaining = mappings.slice(results.length).map((x) => x.source_norm);
        diagnostics.push({
          level: 'cancel',
          message: `运行被手动取消：已处理 ${results.length}/${mappings.length} 个入口，` +
            `未处理 ${remaining.length} 个`,
          remaining,
        });
        return finalize(RUN_STATUS.CANCELLED);
      }
      // 测试/演示钩子：放慢逐条处理，便于复现“运行中取消”
      if (config.verify.stepDelayMs) await sleep(config.verify.stepDelayMs);

      // 1) 歧义键：阻断，不发请求
      if (m.status === 'conflicted') {
        const { rows: amb } = await pool.query(
          `SELECT source_forms, targets FROM mapping_ambiguities WHERE source_norm = $1`,
          [m.source_norm],
        );
        const issues = [
          `同归一化键 ${m.source_norm} 有多个不同目标`,
          ...(amb[0]?.targets ?? []).map((t) => `候选目标: ${t}`),
        ];
        await saveRunVerdict({
          runId: run.id, sourceNorm: m.source_norm, sourceRaw: m.source_raw,
          verdict: 'ambiguity', issues, final: {}, hops: 0, tracker: null,
        });
        results.push({ source_norm: m.source_norm, verdict: 'ambiguity', issues });
        continue;
      }

      // 2) 目标自身解析校验（deleted 类型 target 即自身）
      const t = normalize(m.target_raw);
      const { verdict, issues, crawl, tracker } = await judge(m.source_raw, m.mapping_type, t.normKey);

      for (const h of crawl.hops) {
        await pool.query(
          `INSERT INTO run_crawl_hops
             (run_id, source_norm, hop_index, url_raw, url_norm, status_code,
              location_raw, location_norm, is_redirect, fetch_error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [run.id, m.source_norm, h.index, h.url_raw, h.url_norm, h.status,
           h.location_raw ?? null, h.location_norm ?? null, h.is_redirect, h.fetch_error ?? null],
        );
      }
      await saveRunVerdict({
        runId: run.id, sourceNorm: m.source_norm, sourceRaw: m.source_raw, verdict, issues,
        final: { raw: crawl.finalRaw, norm: crawl.finalNorm, status: crawl.finalStatus },
        hops: crawl.hops.length,
        tracker,
      });
      // 网络级失败（超时/连接拒绝等，区别于白名单拒绝）：该运行证据不完整
      if (crawl.hops.some((h) => h.fetch_error)) {
        networkFailures += 1;
        diagnostics.push({
          level: 'network',
          message: `入口 ${m.source_norm} 请求失败/超时：${
            crawl.hops.find((h) => h.fetch_error)?.fetch_error}`,
          source_norm: m.source_norm,
        });
      }
      results.push({ source_norm: m.source_norm, verdict, issues, hops: crawl.hops.length });
    }

    if (networkFailures > 0) {
      diagnostics.push({
        level: 'fatal',
        message: `${networkFailures}/${mappings.length} 个入口发生网络级失败（本地站点不可达/超时），` +
          '本运行标记为不完整，发布闸门继续使用上一个完整兼容基线',
      });
      return finalize(RUN_STATUS.FAILED);
    }
    return finalize(RUN_STATUS.COMPLETE);
  } catch (e) {
    diagnostics.push({ level: 'fatal', message: `运行异常中断：${e.message}` });
    return finalize(RUN_STATUS.FAILED);
  }
}

/**
 * 只有 complete 运行才更新当前基线表：
 * 全量运行整体替换（并清理已剔除映射的残留结论）；单键运行只合并该键。
 */
async function promoteToBaseline(runId, scope) {
  if (scope === 'all') {
    await pool.query(
      `DELETE FROM verification_verdicts v
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = v.source_norm)`);
    await pool.query(
      `DELETE FROM crawl_results c
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = c.source_norm)`);
  }
  const { rows: verdicts } = await pool.query(
    'SELECT * FROM run_verdicts WHERE run_id=$1', [runId]);
  for (const v of verdicts) {
    await pool.query(
      `INSERT INTO verification_verdicts
         (source_norm, source_raw, final_url_raw, final_url_norm, final_status,
          hops, tracker_preserved, verdict, issues, verified_at, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)
       ON CONFLICT (source_norm) DO UPDATE SET
         source_raw=EXCLUDED.source_raw, final_url_raw=EXCLUDED.final_url_raw,
         final_url_norm=EXCLUDED.final_url_norm, final_status=EXCLUDED.final_status,
         hops=EXCLUDED.hops, tracker_preserved=EXCLUDED.tracker_preserved,
         verdict=EXCLUDED.verdict, issues=EXCLUDED.issues, verified_at=now(),
         run_id=EXCLUDED.run_id`,
      [v.source_norm, v.source_raw, v.final_url_raw, v.final_url_norm, v.final_status,
       v.hops, v.tracker_preserved, v.verdict, JSON.stringify(v.issues ?? []), runId],
    );
    await pool.query('DELETE FROM crawl_results WHERE source_norm=$1', [v.source_norm]);
    const { rows: hops } = await pool.query(
      'SELECT * FROM run_crawl_hops WHERE run_id=$1 AND source_norm=$2 ORDER BY hop_index',
      [runId, v.source_norm]);
    for (const h of hops) {
      await pool.query(
        `INSERT INTO crawl_results
           (source_norm, hop_index, url_raw, url_norm, status_code,
            location_raw, location_norm, is_redirect, fetch_error, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [h.source_norm, h.hop_index, h.url_raw, h.url_norm, h.status_code,
         h.location_raw, h.location_norm, h.is_redirect, h.fetch_error, runId],
      );
    }
  }
}

async function saveRunVerdict({ runId, sourceNorm, sourceRaw, verdict, issues, final, hops, tracker }) {
  await pool.query(
    `INSERT INTO run_verdicts
       (run_id, source_norm, source_raw, final_url_raw, final_url_norm, final_status,
        hops, tracker_preserved, verdict, issues)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (run_id, source_norm) DO UPDATE SET
       source_raw=EXCLUDED.source_raw, final_url_raw=EXCLUDED.final_url_raw,
       final_url_norm=EXCLUDED.final_url_norm, final_status=EXCLUDED.final_status,
       hops=EXCLUDED.hops, tracker_preserved=EXCLUDED.tracker_preserved,
       verdict=EXCLUDED.verdict, issues=EXCLUDED.issues`,
    [runId, sourceNorm, sourceRaw, final.raw ?? null, final.norm ?? null, final.status ?? null,
     hops, tracker ? tracker.ok : null, verdict, JSON.stringify(issues)],
  );
}

export { VERDICT_LABEL };
