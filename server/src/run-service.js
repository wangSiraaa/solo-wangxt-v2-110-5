/**
 * 运行历史服务：输入指纹（映射/策略版本）、基线判定、运行间比较、报告导出。
 *
 * 核心纪律：
 *  - 兼容性 = 映射版本 + 策略版本双一致；本地站点修复（FIXTURE_MODE）只是环境
 *    标签，不影响兼容性——否则“修好一个环”会让新旧运行不可比较。
 *  - 只有 complete 且 scope=all 且与当前映射/策略兼容的运行，才是发布基线；
 *    failed / cancelled / 局部范围运行永远保留诊断但绝不成为基线。
 */
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { config, fixtureOrigin } from './config.js';

export const GOOD_VERDICTS = new Set(['ok', 'deleted_gone_ok']);
export const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled']);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** 当前生效映射的内容指纹 + 执行所需快照（冻结在运行上） */
export async function snapshotMappingVersion() {
  const { rows } = await pool.query(
    `SELECT source_raw, source_norm, target_raw, target_norm, mapping_type, status
       FROM url_mappings ORDER BY source_norm`);
  const identity = rows.map((r) => ({
    source_norm: r.source_norm,
    target_norm: r.target_norm,
    mapping_type: r.mapping_type,
    status: r.status,
  }));
  return {
    version: sha256(JSON.stringify(identity)),
    snapshot: rows,
    count: rows.length,
    conflicted: rows.filter((r) => r.status === 'conflicted').length,
  };
}

/** 当前规范化 + 白名单 + 爬取预算的策略指纹 */
export function snapshotPolicyVersion() {
  const snapshot = {
    normalize: {
      scheme: config.rules.scheme,
      tailSlashMode: config.rules.tailSlashMode,
      dropFragment: config.rules.dropFragment,
      trackerParams: [...config.rules.trackerParams].sort(),
      unknownQueryIsIdentity: config.rules.unknownQueryIsIdentity,
    },
    allowlist: { host: config.fixture.host, port: config.fixture.port },
    crawl: { maxRedirects: config.crawl.maxRedirects, timeoutMs: config.crawl.timeoutMs },
  };
  return { version: sha256(JSON.stringify(snapshot)), snapshot };
}

export async function currentVersions() {
  const m = await snapshotMappingVersion();
  const p = snapshotPolicyVersion();
  return { mapping_version: m.version, policy_version: p.version };
}

/** 运行能否作为“当前”发布基线（complete + 全量 + 与当前映射/策略兼容） */
export function baselineEligibility(run, cur) {
  const reasons = [];
  if (run.status !== 'complete') {
    reasons.push(`终态为 ${run.status}（${STATUS_LABEL[run.status] ?? run.status}），只有 complete 才能作为基线`);
  }
  if (run.scope !== 'all') {
    reasons.push(`选择范围为 ${run.scope}（局部验证），发布基线必须覆盖全部生效映射`);
  }
  if (run.mapping_version !== cur.mapping_version) {
    reasons.push('输入映射版本与当前不一致（映射表在此运行后已变更）');
  }
  if (run.policy_version !== cur.policy_version) {
    reasons.push('规范化/白名单策略版本与当前不一致（策略在此运行后已变更）');
  }
  return { eligible: reasons.length === 0, reasons };
}

/** 当前基线：最新一个 complete + 全量 + 与当前版本兼容的运行；没有则 null */
export async function currentBaseline() {
  const cur = await currentVersions();
  const { rows } = await pool.query(
    `SELECT * FROM verification_runs
      WHERE status='complete' AND scope='all'
        AND mapping_version=$1 AND policy_version=$2
      ORDER BY id DESC LIMIT 1`,
    [cur.mapping_version, cur.policy_version]);
  return rows[0] ?? null;
}

export async function getRun(id) {
  const { rows } = await pool.query('SELECT * FROM verification_runs WHERE id=$1', [id]);
  return rows[0] ?? null;
}

export async function getRunItems(runId) {
  const { rows } = await pool.query(
    'SELECT * FROM run_items WHERE run_id=$1 ORDER BY source_norm', [runId]);
  return rows;
}

export async function listRuns(limit = 50) {
  const cur = await currentVersions();
  const baseline = await currentBaseline();
  const { rows } = await pool.query(
    'SELECT * FROM verification_runs ORDER BY id DESC LIMIT $1', [limit]);
  return rows.map((r) => ({
    ...summarizeRun(r),
    is_current_baseline: baseline?.id === r.id,
    baseline_eligibility: baselineEligibility(r, cur),
  }));
}

/** 运行的输入摘要（报告与列表展示用） */
export function summarizeRun(r) {
  const p = r.policy_snapshot ?? {};
  return {
    id: r.id,
    status: r.status,
    status_label: STATUS_LABEL[r.status] ?? r.status,
    terminal: TERMINAL_STATUSES.has(r.status),
    scope: r.scope,
    scope_keys: r.scope_keys ?? null,
    mapping_version: r.mapping_version,
    mapping_version_short: r.mapping_version?.slice(0, 12),
    mapping_count: r.mapping_count,
    conflicted_count: r.conflicted_count,
    policy_version: r.policy_version,
    policy_version_short: r.policy_version?.slice(0, 12),
    policy_summary: {
      tailSlashMode: p.normalize?.tailSlashMode,
      trackerParams: p.normalize?.trackerParams?.length ?? 0,
      allowlist: p.allowlist ? `${p.allowlist.host}:${p.allowlist.port}` : null,
      maxRedirects: p.crawl?.maxRedirects,
      timeoutMs: p.crawl?.timeoutMs,
    },
    fixture_mode: r.fixture_mode,
    total: r.total,
    done_count: r.done_count,
    fail_count: r.fail_count,
    diagnostics: r.diagnostics ?? [],
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

export const STATUS_LABEL = {
  running: '进行中',
  complete: '完整',
  failed: '失败',
  cancelled: '已取消',
};

/** 两个运行是否可比较（映射版本与策略版本都必须一致） */
export function runPairCompatibility(base, head) {
  const reasons = [];
  if (base.mapping_version !== head.mapping_version) {
    reasons.push(
      `输入映射版本不同（#${base.id}: ${base.mapping_version.slice(0, 12)}… ≠ ` +
      `#${head.id}: ${head.mapping_version.slice(0, 12)}…）：映射表在两次运行之间已变更，` +
      '逐条差异不再针对同一输入，比较无业务意义');
  }
  if (base.policy_version !== head.policy_version) {
    reasons.push(
      `规范化/白名单策略版本不同（#${base.id}: ${base.policy_version.slice(0, 12)}… ≠ ` +
      `#${head.id}: ${head.policy_version.slice(0, 12)}…）：两次运行的裁决口径不一致`);
  }
  return { compatible: reasons.length === 0, reasons };
}

/**
 * 比较两个运行：按同一归一化键（source_norm）与同一原始入口（source_raw）对齐。
 * 分桶：fixed（已修复）/ regressed（状态回退）/ new_failures（新增失败）/
 *       not_comparable（不可比较：单侧缺失或证据不完整）。
 */
export async function compareRuns(baseId, headId) {
  const [base, head] = await Promise.all([getRun(baseId), getRun(headId)]);
  if (!base || !head) return null;
  const compat = runPairCompatibility(base, head);
  const result = {
    base: summarizeRun(base),
    head: summarizeRun(head),
    compatible: compat.compatible,
    reasons: compat.reasons,
    warnings: [],
    generated_at: new Date().toISOString(),
  };
  if (!compat.compatible) return result;

  if (base.status !== 'complete') {
    result.warnings.push(`基准运行 #${base.id} 终态为 ${base.status}，未覆盖的入口将列入“不可比较”`);
  }
  if (head.status !== 'complete') {
    result.warnings.push(`对比运行 #${head.id} 终态为 ${head.status}，未覆盖的入口将列入“不可比较”`);
  }

  const [baseItems, headItems] = await Promise.all([getRunItems(baseId), getRunItems(headId)]);
  const bMap = new Map(baseItems.map((i) => [i.source_norm, i]));
  const hMap = new Map(headItems.map((i) => [i.source_norm, i]));
  const keys = [...new Set([...bMap.keys(), ...hMap.keys()])].sort();

  const buckets = { fixed: [], regressed: [], new_failures: [], not_comparable: [] };
  let unchangedGood = 0;
  let unchangedBad = 0;

  const entry = (key, b, h, extra = {}) => ({
    source_norm: key,
    source_raw: (h ?? b).source_raw,
    base_verdict: b?.verdict ?? null,
    head_verdict: h?.verdict ?? null,
    base_issues: b?.issues ?? [],
    head_issues: h?.issues ?? [],
    ...extra,
  });

  for (const key of keys) {
    const b = bMap.get(key);
    const h = hMap.get(key);
    if (!b) {
      // 只出现在新运行：失败即“新增失败”，否则无法与基线对齐
      if (GOOD_VERDICTS.has(h.verdict)) {
        buckets.not_comparable.push(entry(key, b, h, { reason: '基准运行未覆盖此入口' }));
      } else {
        buckets.new_failures.push(entry(key, b, h, { reason: '基准运行未覆盖此入口，新运行即失败' }));
      }
      continue;
    }
    if (!h) {
      buckets.not_comparable.push(entry(key, b, h, { reason: '对比运行未覆盖此入口（运行不完整或范围不同）' }));
      continue;
    }
    if (b.item_status !== 'done' || h.item_status !== 'done' || !b.verdict || !h.verdict) {
      buckets.not_comparable.push(entry(key, b, h, { reason: '至少一侧证据不完整（条目未正常结束）' }));
      continue;
    }
    const bGood = GOOD_VERDICTS.has(b.verdict);
    const hGood = GOOD_VERDICTS.has(h.verdict);
    if (bGood && hGood) unchangedGood++;
    else if (!bGood && !hGood) {
      unchangedBad++;
      if (b.verdict !== h.verdict) {
        // 仍在失败但失败形态变了，记入备注供人查看（不算业务变化）
        buckets.not_comparable.push(entry(key, b, h, {
          reason: `失败形态变化：${b.verdict} → ${h.verdict}（两侧均未通过，不计入修复/回退）`,
        }));
      }
    } else if (!bGood && hGood) buckets.fixed.push(entry(key, b, h));
    else buckets.regressed.push(entry(key, b, h));
  }

  result.buckets = buckets;
  result.counts = {
    unchanged_good: unchangedGood,
    unchanged_bad: unchangedBad,
    fixed: buckets.fixed.length,
    regressed: buckets.regressed.length,
    new_failures: buckets.new_failures.length,
    not_comparable: buckets.not_comparable.length,
  };
  // 稳定 = 没有任何业务变化（修复/回退/新增失败/不可比较均为空）
  result.stable =
    buckets.fixed.length === 0 && buckets.regressed.length === 0 &&
    buckets.new_failures.length === 0 && buckets.not_comparable.length === 0;
  return result;
}

/** 进程重启时仍在 running 的运行：标记 failed（中断诊断保留，绝不成为基线） */
export async function markInterruptedRuns() {
  const { rowCount } = await pool.query(
    `UPDATE verification_runs
        SET status='failed', finished_at=now(),
            diagnostics = diagnostics || $1::jsonb
      WHERE status='running'`,
    [JSON.stringify(['进程中断：服务停止/重启时运行仍在进行，标记为 failed；已完成的条目证据保留'])],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// 报告导出（Markdown）：必须带运行标识与输入摘要
// ---------------------------------------------------------------------------

function runSummaryMd(tag, s) {
  return [
    `### ${tag}：运行 #${s.id}（${s.status_label}）`,
    '',
    `- 映射版本：\`${s.mapping_version}\`（${s.mapping_count} 条生效映射，${s.conflicted_count} 条歧义）`,
    `- 策略版本：\`${s.policy_version}\`（尾斜杠=${s.policy_summary.tailSlashMode}，白名单=${s.policy_summary.allowlist}，最长链=${s.policy_summary.maxRedirects}，超时=${s.policy_summary.timeoutMs}ms，追踪参数=${s.policy_summary.trackerParams} 个）`,
    `- 选择范围：${s.scope}${s.scope_keys ? `（${s.scope_keys.length} 个键）` : ''}；本地站点模式：${s.fixture_mode}`,
    `- 开始：${s.started_at}；结束：${s.finished_at ?? '—'}；完成 ${s.done_count}/${s.total}，失败条目 ${s.fail_count}`,
    ...(s.diagnostics?.length ? ['- 诊断：', ...s.diagnostics.map((d) => `  - ${d}`)] : []),
    '',
  ].join('\n');
}

export function comparisonReportMd(cmp) {
  let md = `# 验证运行对比报告\n\n> 生成时间：${cmp.generated_at}\n>\n`;
  md += `> 基准运行 **#${cmp.base.id}** vs 对比运行 **#${cmp.head.id}**\n\n`;
  md += runSummaryMd('基准（base）', cmp.base);
  md += runSummaryMd('对比（head）', cmp.head);

  if (!cmp.compatible) {
    md += `## ⛔ 输入不兼容，无法给出业务差异结论\n\n`;
    for (const r of cmp.reasons) md += `- ${r}\n`;
    md += `\n旧运行不能作为新方案的放行依据；请在当前映射与策略下执行一次完整验证。\n`;
    return md;
  }

  for (const w of cmp.warnings) md += `> ⚠️ ${w}\n`;
  md += '\n## 结论\n\n';
  md += cmp.stable
    ? '**稳定：两次运行无业务变化**（无新增失败、无修复、无回退、无不可比较项）。\n\n'
    : `**存在差异**：已修复 ${cmp.counts.fixed}，状态回退 ${cmp.counts.regressed}，` +
      `新增失败 ${cmp.counts.new_failures}，不可比较 ${cmp.counts.not_comparable}。\n\n`;
  md += `| 指标 | 数量 |\n|---|---|\n`;
  md += `| 持续通过 | ${cmp.counts.unchanged_good} |\n| 持续失败（形态未变） | ${cmp.counts.unchanged_bad} |\n`;
  md += `| 已修复 | ${cmp.counts.fixed} |\n| 状态回退 | ${cmp.counts.regressed} |\n`;
  md += `| 新增失败 | ${cmp.counts.new_failures} |\n| 不可比较 | ${cmp.counts.not_comparable} |\n\n`;

  const table = (title, rows, showReason) => {
    let t = `## ${title}（${rows.length}）\n\n`;
    if (!rows.length) return t + '（无）\n\n';
    t += `| 原始入口 | 归一化键 | #${cmp.base.id} 裁决 | #${cmp.head.id} 裁决 |${showReason ? ' 说明 |' : ' 问题（新） |'}\n|---|---|---|---|---|\n`;
    for (const e of rows) {
      const last = showReason
        ? e.reason ?? '—'
        : (e.head_issues || []).join('；') || '—';
      t += `| \`${e.source_raw}\` | \`${e.source_norm}\` | ${e.base_verdict ?? '—'} | ${e.head_verdict ?? '—'} | ${last} |\n`;
    }
    return t + '\n';
  };
  md += table('✅ 已修复', cmp.buckets.fixed);
  md += table('🔻 状态回退', cmp.buckets.regressed);
  md += table('🆕 新增失败', cmp.buckets.new_failures);
  md += table('⚠️ 不可比较项', cmp.buckets.not_comparable, true);
  return md;
}

export function runReportMd(run, items) {
  const s = summarizeRun(run);
  let md = `# 验证运行证据报告：运行 #${s.id}\n\n`;
  md += runSummaryMd('运行', s);
  md += `## 逐条裁决（${items.length}）\n\n`;
  for (const it of items) {
    md += `### ${GOOD_VERDICTS.has(it.verdict) ? '✅' : '❌'} ${it.source_raw}\n\n`;
    md += `- 归一化键：\`${it.source_norm}\`\n`;
    md += `- 裁决：**${it.verdict ?? '（无）'}**；最终状态：${it.final_status ?? '—'}；跳数：${it.hops}\n`;
    md += `- 最终 URL：\`${it.final_url_raw ?? '—'}\`\n`;
    if (it.issues?.length) md += `- 问题：${it.issues.map((x) => `\n  - ${x}`).join('')}\n`;
    if (it.hops_detail?.length) {
      md += `\n| 跳 | 请求 URL（规范化） | 状态 | Location（原样） |\n|---|---|---|---|\n`;
      for (const h of it.hops_detail) {
        md += `| ${h.index} | \`${h.url_norm}\` | ${h.status ?? '—'}${h.fetch_error ? `（${h.fetch_error}）` : ''} | \`${h.location_raw ?? '—'}\` |\n`;
      }
    }
    md += '\n';
  }
  return md;
}

export { fixtureOrigin };
