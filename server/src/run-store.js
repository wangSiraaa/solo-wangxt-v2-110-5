/**
 * 版本化验证运行（verification runs）的存储与判定逻辑。
 *
 * 核心概念：
 *  - 输入版本指纹：mapping_fingerprint（生效映射集合）+ policy_fingerprint
 *    （规范化规则 / 白名单 / 爬取预算）。两个指纹都相同，两次运行才“兼容”。
 *  - 终态：complete / failed / cancelled。running 是进行中的非终态。
 *  - 基线（baseline）：最近一次 complete、全量（scope=all）、且指纹与当前
 *    输入兼容的运行。只有基线能作为迁移方案的发布依据；failed / cancelled /
 *    局部失败的运行只保留诊断，绝不顶替基线。
 *  - 比较：按归一化键对齐两次运行的裁决，分出 新增失败 / 已修复 /
 *    状态回退 / 通过但证据变化 / 不可比较 / 无变化。
 */
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { config } from './config.js';

export const RUN_STATUS = {
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const RUN_STATUS_LABEL = {
  running: '进行中',
  complete: '完整',
  failed: '失败（不完整）',
  cancelled: '已取消（不完整）',
};

export const GOOD_VERDICTS = new Set(['ok', 'deleted_gone_ok']);

/** 稳定序列化（键排序），保证同一输入永远得到同一指纹 */
function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function fingerprintOf(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 16);
}

/** 规范化 + 白名单 + 爬取策略快照（影响裁决的一切规则） */
export function policySnapshot() {
  return {
    normalize: {
      tailSlashMode: config.rules.tailSlashMode,
      dropFragment: config.rules.dropFragment,
      trackerParams: [...config.rules.trackerParams].sort(),
      unknownQueryIsIdentity: config.rules.unknownQueryIsIdentity,
    },
    allowlist: {
      scheme: config.rules.scheme,
      host: config.fixture.host,
      port: config.fixture.port,
    },
    crawl: {
      maxRedirects: config.crawl.maxRedirects,
      timeoutMs: config.crawl.timeoutMs,
    },
  };
}

export function policyFingerprint() {
  return fingerprintOf(policySnapshot());
}

/** 生效映射集合快照：entries 用于指纹，summary 用于报告/界面展示 */
export async function mappingSnapshot(client = pool) {
  const { rows: mappings } = await client.query(
    `SELECT source_norm, target_norm, mapping_type, status
       FROM url_mappings ORDER BY source_norm`);
  const { rows: [{ n: inputs }] } = await client.query(
    'SELECT count(*)::int AS n FROM mapping_inputs');
  const entries = mappings.map((m) => [m.source_norm, m.target_norm, m.mapping_type, m.status]);
  return {
    entries,
    summary: {
      total: mappings.length,
      active: mappings.filter((m) => m.status === 'active').length,
      conflicted: mappings.filter((m) => m.status === 'conflicted').length,
      inputs,
    },
  };
}

/** 当前输入版本（映射 + 策略）。运行开始时冻结，兼容性判定时重算。 */
export async function currentInputVersion(client = pool) {
  const snap = await mappingSnapshot(client);
  const policy = policySnapshot();
  return {
    mappingFingerprint: fingerprintOf(snap.entries),
    mappingSummary: snap.summary,
    policyFingerprint: fingerprintOf(policy),
    policySnapshot: policy,
  };
}

/** 运行与当前输入（或两次运行之间）的兼容性；返回差异原因（空数组 = 兼容） */
export function compatibilityReasons(a, b) {
  const reasons = [];
  if (a.mapping_fingerprint !== b.mapping_fingerprint) {
    reasons.push(
      `输入映射版本不同（${a.mapping_fingerprint} ≠ ${b.mapping_fingerprint}）：` +
      '映射录入/裁决发生过变化，旧运行的证据不能覆盖新方案');
  }
  if (a.policy_fingerprint !== b.policy_fingerprint) {
    reasons.push(
      `规范化/白名单策略不同（${a.policy_fingerprint} ≠ ${b.policy_fingerprint}）：` +
      '规则变化后旧证据不可直接沿用');
  }
  return reasons;
}

/** 创建一条运行记录（状态 running），冻结输入版本 */
export async function insertRun({ scope, scopeKeys, input }) {
  const { rows } = await pool.query(
    `INSERT INTO verification_runs
       (scope, scope_keys, mapping_fingerprint, mapping_summary,
        policy_fingerprint, policy_snapshot, fixture_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [scope, JSON.stringify(scopeKeys), input.mappingFingerprint,
     JSON.stringify(input.mappingSummary), input.policyFingerprint,
     JSON.stringify(input.policySnapshot),
     process.env.FIXTURE_MODE === 'fixed' ? 'fixed' : 'default']);
  return rows[0];
}

export async function finishRun(runId, status, totals, diagnostics) {
  const { rows } = await pool.query(
    `UPDATE verification_runs
        SET status=$2, totals=$3, diagnostics=$4, finished_at=now()
      WHERE id=$1 RETURNING *`,
    [runId, status, JSON.stringify(totals), JSON.stringify(diagnostics)]);
  return rows[0];
}

export async function getRun(runId) {
  const { rows } = await pool.query('SELECT * FROM verification_runs WHERE id=$1', [runId]);
  return rows[0] ?? null;
}

export async function getRunVerdicts(runId) {
  const { rows } = await pool.query(
    'SELECT * FROM run_verdicts WHERE run_id=$1 ORDER BY source_norm', [runId]);
  return rows;
}

export async function getRunHops(runId, sourceNorm = null) {
  if (sourceNorm) {
    const { rows } = await pool.query(
      `SELECT * FROM run_crawl_hops WHERE run_id=$1 AND source_norm=$2 ORDER BY hop_index`,
      [runId, sourceNorm]);
    return rows;
  }
  const { rows } = await pool.query(
    'SELECT * FROM run_crawl_hops WHERE run_id=$1 ORDER BY source_norm, hop_index', [runId]);
  return rows;
}

/**
 * 当前发布基线：最近一次 complete + 全量 + 与当前输入兼容的运行。
 * 找不到时给出明确原因（为什么不能作为基线），供闸门与界面展示。
 */
export async function getBaselineRun(client = pool) {
  const current = await currentInputVersion(client);
  const { rows } = await client.query(
    `SELECT * FROM verification_runs
      WHERE status='complete' AND scope='all' ORDER BY id DESC`);
  const run = rows.find(
    (r) => r.mapping_fingerprint === current.mappingFingerprint
        && r.policy_fingerprint === current.policyFingerprint);
  if (run) return { run, current, reasons: [] };

  const reasons = [];
  if (!rows.length) {
    reasons.push('尚无任何完整（complete）的全量验证运行；填表不等于迁移完成');
  } else {
    const latest = rows[0];
    for (const r of compatibilityReasons(
      { mapping_fingerprint: latest.mapping_fingerprint, policy_fingerprint: latest.policy_fingerprint },
      { mapping_fingerprint: current.mappingFingerprint, policy_fingerprint: current.policyFingerprint },
    )) {
      reasons.push(`最近一次完整运行 #${latest.id} 已失效：${r}`);
    }
  }
  const { rows: incomplete } = await client.query(
    `SELECT id, status FROM verification_runs
      WHERE status IN ('failed','cancelled') ORDER BY id DESC LIMIT 1`);
  if (incomplete.length) {
    reasons.push(
      `最近一次运行 #${incomplete[0].id} 未完整（${incomplete[0].status}），` +
      '只保留诊断，不能顶替上一个完整基线');
  }
  return { run: null, current, reasons };
}

// ---------------------------------------------------------------------------
// 运行比较
// ---------------------------------------------------------------------------

function summarizeVerdict(v) {
  return {
    verdict: v.verdict,
    final_status: v.final_status,
    final_url_norm: v.final_url_norm,
    hops: v.hops,
  };
}

function sameEvidence(a, b) {
  return a.verdict === b.verdict
    && a.final_status === b.final_status
    && a.final_url_norm === b.final_url_norm
    && a.hops === b.hops;
}

/**
 * 纯函数：按归一化键对齐两次运行的裁决。
 * 桶：fixed（已修复）/ new_failures（新增失败）/ regressed（状态回退：
 * 两次都未通过但失败形态或最终状态改变）/ changed（均通过但证据变化）/
 * unchanged（无业务变化）/ incomparable（仅一侧存在该入口）。
 */
export function diffVerdicts(aRows, bRows) {
  const aBy = new Map(aRows.map((r) => [r.source_norm, r]));
  const bBy = new Map(bRows.map((r) => [r.source_norm, r]));
  const keys = [...new Set([...aBy.keys(), ...bBy.keys()])].sort();
  const diff = {
    fixed: [], new_failures: [], regressed: [],
    changed: [], unchanged: [], incomparable: [],
  };
  for (const key of keys) {
    const a = aBy.get(key);
    const b = bBy.get(key);
    if (!a || !b) {
      const only = a ?? b;
      diff.incomparable.push({
        source_norm: key,
        source_raw: only.source_raw,
        note: a ? '仅存在于较早运行（另一侧未覆盖该入口）' : '仅存在于较晚运行（另一侧未覆盖该入口）',
      });
      continue;
    }
    const item = {
      source_norm: key, source_raw: a.source_raw,
      a: summarizeVerdict(a), b: summarizeVerdict(b),
    };
    const aGood = GOOD_VERDICTS.has(a.verdict);
    const bGood = GOOD_VERDICTS.has(b.verdict);
    if (aGood && bGood) {
      if (sameEvidence(a, b)) diff.unchanged.push(item);
      else diff.changed.push({ ...item, note: '两次均通过，但最终状态/落点/跳数有变化' });
    } else if (!aGood && bGood) {
      diff.fixed.push(item);
    } else if (aGood && !bGood) {
      diff.new_failures.push(item);
    } else if (a.verdict === b.verdict && a.final_status === b.final_status) {
      diff.unchanged.push(item);
    } else {
      diff.regressed.push({ ...item, note: '两次均未通过，失败形态或最终状态发生变化' });
    }
  }
  return diff;
}

export function diffSummary(diff) {
  return Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length]));
}

/**
 * 比较两次运行。指纹不兼容时不做逐条对比，直接返回原因——
 * 旧 run 不能用来给新方案放行。
 */
export async function compareRuns(aId, bId) {
  const a = await getRun(aId);
  const b = await getRun(bId);
  if (!a || !b) return { error: `运行不存在: ${!a ? aId : bId}` };
  const reasons = compatibilityReasons(a, b);
  const warnings = [];
  for (const r of [a, b]) {
    if (r.status !== 'complete') {
      warnings.push(`运行 #${r.id} 未完整（${r.status}），其未覆盖的入口将列为不可比较`);
    } else if (r.scope !== 'all') {
      warnings.push(`运行 #${r.id} 是部分范围运行（scope=keys），未覆盖的入口将列为不可比较`);
    }
  }
  const meta = (r) => ({
    id: r.id, status: r.status, scope: r.scope,
    started_at: r.started_at, finished_at: r.finished_at,
    mapping_fingerprint: r.mapping_fingerprint,
    policy_fingerprint: r.policy_fingerprint,
    mapping_summary: r.mapping_summary,
    policy_snapshot: r.policy_snapshot,
    totals: r.totals,
  });
  if (reasons.length) {
    return { compatible: false, reasons, warnings, a: meta(a), b: meta(b) };
  }
  const [aRows, bRows] = await Promise.all([getRunVerdicts(aId), getRunVerdicts(bId)]);
  const diff = diffVerdicts(aRows, bRows);
  return {
    compatible: true, reasons: [], warnings,
    a: meta(a), b: meta(b), diff, summary: diffSummary(diff),
  };
}

// ---------------------------------------------------------------------------
// 报告导出（Markdown，带运行标识与输入摘要）
// ---------------------------------------------------------------------------

const VERDICT_TEXT = {
  ok: '通过', redirect_loop: '重定向环', chain_too_long: '跳转链过长',
  fetch_error: '请求被拒/失败', deleted_gone_ok: '已删除-状态正确',
  deleted_not_gone: '已删除但未消亡', ambiguity: '归一化歧义',
  final_status_bad: '最终页状态异常',
};

function runHeader(r, title) {
  const p = r.policy_snapshot ?? {};
  const m = r.mapping_summary ?? {};
  return `# ${title}

> 运行编号：**#${r.id}**　状态：**${RUN_STATUS_LABEL[r.status] ?? r.status}**　范围：${r.scope}
> 开始：${new Date(r.started_at).toISOString()}　结束：${r.finished_at ? new Date(r.finished_at).toISOString() : '—（未结束）'}

## 输入摘要（运行开始时冻结）

| 项 | 值 |
|---|---|
| 映射指纹 | \`${r.mapping_fingerprint}\` |
| 策略指纹 | \`${r.policy_fingerprint}\` |
| 生效映射 | ${m.total ?? '—'} 条（生效 ${m.active ?? '—'} / 冲突 ${m.conflicted ?? '—'}，原始录入 ${m.inputs ?? '—'} 条） |
| 白名单 | \`${p.allowlist?.scheme ?? 'http:'}//${p.allowlist?.host}:${p.allowlist?.port}\` |
| 规范化 | 尾斜杠 \`${p.normalize?.tailSlashMode}\`，追踪参数 ${(p.normalize?.trackerParams ?? []).join(', ')} |
| 爬取预算 | 最多 ${p.crawl?.maxRedirects} 跳，单跳超时 ${p.crawl?.timeoutMs} ms |
`;
}

function diagnosticsSection(r) {
  const diags = r.diagnostics ?? [];
  if (!diags.length) return '';
  let md = `\n## 诊断（该运行未完整，不能作为发布基线）\n\n`;
  for (const d of diags) md += `- **${d.level ?? 'info'}**：${d.message}\n`;
  return md;
}

export async function buildRunReport(runId) {
  const run = await getRun(runId);
  if (!run) return null;
  const verdicts = await getRunVerdicts(runId);
  const hops = await getRunHops(runId);
  const hopsBy = new Map();
  for (const h of hops) {
    if (!hopsBy.has(h.source_norm)) hopsBy.set(h.source_norm, []);
    hopsBy.get(h.source_norm).push(h);
  }
  let md = runHeader(run, `验证运行报告`);
  md += diagnosticsSection(run);
  md += `\n## 逐条裁决（${verdicts.length} 个入口）\n`;
  for (const v of verdicts) {
    const good = GOOD_VERDICTS.has(v.verdict);
    md += `\n### ${good ? '✅' : '❌'} ${v.source_raw}\n\n`;
    md += `- 裁决：**${VERDICT_TEXT[v.verdict] ?? v.verdict}**；最终状态：${v.final_status ?? '—'}；跳数：${v.hops}\n`;
    md += `- 最终 URL：\`${v.final_url_raw ?? '—'}\`\n`;
    if (v.issues?.length) md += `- 问题：${v.issues.map((x) => `\n  - ${x}`).join('')}\n`;
    const hh = hopsBy.get(v.source_norm) ?? [];
    if (hh.length) {
      md += `\n| 跳 | 请求 URL（规范化） | 状态 | Location（原样） |\n|---|---|---|---|\n`;
      for (const h of hh) {
        md += `| ${h.hop_index} | \`${h.url_norm}\` | ${h.status_code ?? '—'}${h.fetch_error ? `（${h.fetch_error}）` : ''} | \`${h.location_raw ?? '—'}\` |\n`;
      }
    }
  }
  return md;
}

export async function buildCompareReport(aId, bId) {
  const cmp = await compareRuns(aId, bId);
  if (cmp.error) return null;
  let md = `# 运行比较报告：#${cmp.a.id} → #${cmp.b.id}\n\n`;
  md += `| | 运行 A | 运行 B |\n|---|---|---|\n`;
  md += `| 编号 | #${cmp.a.id} | #${cmp.b.id} |\n`;
  md += `| 状态 | ${RUN_STATUS_LABEL[cmp.a.status] ?? cmp.a.status} | ${RUN_STATUS_LABEL[cmp.b.status] ?? cmp.b.status} |\n`;
  md += `| 开始时间 | ${new Date(cmp.a.started_at).toISOString()} | ${new Date(cmp.b.started_at).toISOString()} |\n`;
  md += `| 映射指纹 | \`${cmp.a.mapping_fingerprint}\` | \`${cmp.b.mapping_fingerprint}\` |\n`;
  md += `| 策略指纹 | \`${cmp.a.policy_fingerprint}\` | \`${cmp.b.policy_fingerprint}\` |\n`;
  md += `| 生效映射 | ${cmp.a.mapping_summary?.total ?? '—'} 条 | ${cmp.b.mapping_summary?.total ?? '—'} 条 |\n`;

  if (!cmp.compatible) {
    md += `\n## ⛔ 输入不兼容，无法比较\n\n`;
    for (const r of cmp.reasons) md += `- ${r}\n`;
    md += `\n旧运行的证据不能作为新映射/新策略下方案的放行依据。\n`;
    return md;
  }

  const s = cmp.summary;
  md += `\n## 结论\n\n`;
  md += `| 新增失败 | 已修复 | 状态回退 | 通过但证据变化 | 无变化 | 不可比较 |\n`;
  md += `|---|---|---|---|---|---|\n`;
  md += `| ${s.new_failures} | ${s.fixed} | ${s.regressed} | ${s.changed} | ${s.unchanged} | ${s.incomparable} |\n`;
  if (cmp.warnings?.length) {
    md += `\n> ⚠️ ${cmp.warnings.join('；')}\n`;
  }
  if (s.new_failures === 0 && s.fixed === 0 && s.regressed === 0 && s.changed === 0 && s.incomparable === 0) {
    md += `\n**两次完整运行结果稳定：无新增失败、无回退、无业务变化。**\n`;
  }

  const bucket = (title, rows, render) => {
    if (!rows.length) return '';
    let out = `\n## ${title}（${rows.length}）\n\n| 入口（原始） | 归一化键 | 运行 A | 运行 B |\n|---|---|---|---|\n`;
    for (const r of rows) out += render(r);
    return out;
  };
  const cell = (v) => (v ? `${VERDICT_TEXT[v.verdict] ?? v.verdict} / ${v.final_status ?? '—'}` : '—');
  const row = (r) => `| \`${r.source_raw}\` | \`${r.source_norm}\` | ${cell(r.a)} | ${cell(r.b)} |\n`;
  md += bucket('🆕 新增失败', cmp.diff.new_failures, row);
  md += bucket('✅ 已修复', cmp.diff.fixed, row);
  md += bucket('↩️ 状态回退（仍未通过，但失败形态变化）', cmp.diff.regressed, row);
  md += bucket('🔀 通过但证据变化', cmp.diff.changed, row);
  md += bucket('⚠️ 不可比较项', cmp.diff.incomparable,
    (r) => `| \`${r.source_raw}\` | \`${r.source_norm}\` | — | ${r.note} |\n`);
  return md;
}
