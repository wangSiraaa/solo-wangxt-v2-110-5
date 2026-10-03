<template>
  <div class="panel">
    <h2>版本化验证运行 —— 每次运行冻结输入映射、策略与逐跳证据</h2>
    <div class="row" style="align-items:center">
      <p class="muted small" style="flex:3">
        每次运行冻结：输入映射版本、规范化/白名单策略版本、选择范围、逐跳链与最终裁决。
        终态：<b>complete</b>（完整）/ <b>failed</b>（失败）/ <b>cancelled</b>（已取消）。
        只有 <b>complete 且与当前映射/策略兼容的全量运行</b>才能作为发布基线；
        中断、超时或局部失败的运行保留诊断，但绝不替换最后一个完整基线。
      </p>
      <div style="flex:1; text-align:right">
        <button class="btn" :disabled="starting || !!runningId" @click="start">
          {{ runningId ? `运行 #${runningId} 进行中…` : starting ? '启动中…' : '开始全量验证运行' }}
        </button>
      </div>
    </div>
    <div v-if="baseline" class="callout ok small">
      当前发布基线：运行 <b>#{{ baseline.id }}</b>（{{ fmt(baseline.started_at) }}，
      映射 {{ baseline.mapping_count }} 条 / 版本 {{ baseline.mapping_version_short }}…，
      策略 {{ baseline.policy_version_short }}…）
    </div>
    <div v-else class="callout bad small">
      当前没有可作为发布基线的运行——需要一次 complete 且与当前映射/策略兼容的全量运行。
    </div>
  </div>

  <div class="panel">
    <h2>运行历史</h2>
    <table>
      <thead>
        <tr>
          <th>运行</th><th>终态</th><th>范围</th><th>映射版本</th><th>策略版本</th>
          <th>完成/总数</th><th>开始时间</th><th>基线资格</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in runs" :key="r.id" :class="{ selected: detail?.run?.id === r.id }">
          <td>
            #{{ r.id }}
            <span v-if="r.is_current_baseline" class="badge ok">当前基线</span>
          </td>
          <td>
            <span class="badge" :class="statusCls(r.status)">{{ r.status_label }}</span>
          </td>
          <td>{{ r.scope === 'all' ? '全量' : `局部(${r.scope_keys?.length ?? 0})` }}</td>
          <td class="mono">{{ r.mapping_version_short }}…</td>
          <td class="mono">{{ r.policy_version_short }}…</td>
          <td>{{ r.done_count }}/{{ r.total }}<span v-if="r.fail_count" style="color:var(--bad)">（失败 {{ r.fail_count }}）</span></td>
          <td class="small">{{ fmt(r.started_at) }}</td>
          <td class="small">
            <span v-if="r.baseline_eligibility.eligible" class="badge ok">可作基线</span>
            <ul v-else class="issues">
              <li v-for="(x, i) in r.baseline_eligibility.reasons" :key="i">{{ x }}</li>
            </ul>
          </td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(r.id)">详情</a>
            <template v-if="r.status === 'running'"> · <a href="#" @click.prevent="cancel(r.id)">取消</a></template>
            · <a :href="api.runReportUrl(r.id)" target="_blank">导出</a>
          </td>
        </tr>
        <tr v-if="!runs.length"><td colspan="9" class="muted">还没有验证运行</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="detail">
    <h2>运行 #{{ detail.run.id }} 详情（{{ detail.run.status_label }}）</h2>
    <div class="kpi" style="margin-bottom:10px">
      <div class="card"><div class="num">{{ detail.run.mapping_count }}</div><div class="lbl">冻结映射（歧义 {{ detail.run.conflicted_count }}）</div></div>
      <div class="card"><div class="num">{{ detail.run.done_count }}/{{ detail.run.total }}</div><div class="lbl">完成条目</div></div>
      <div class="card"><div class="num" style="color:var(--bad)">{{ detail.run.fail_count }}</div><div class="lbl">失败条目</div></div>
      <div class="card"><div class="num">{{ detail.run.fixture_mode }}</div><div class="lbl">站点模式（环境标签）</div></div>
    </div>
    <p class="small muted">
      映射版本 <span class="mono">{{ detail.run.mapping_version }}</span><br>
      策略版本 <span class="mono">{{ detail.run.policy_version }}</span>
      （尾斜杠={{ detail.run.policy_summary.tailSlashMode }}，
      白名单={{ detail.run.policy_summary.allowlist }}，
      最长链={{ detail.run.policy_summary.maxRedirects }}，
      超时={{ detail.run.policy_summary.timeoutMs }}ms）
    </p>
    <div v-if="detail.run.diagnostics?.length" class="callout bad">
      <b>诊断（不完整运行的原因，证据保留但不作基线）：</b>
      <ul class="issues"><li v-for="(d, i) in detail.run.diagnostics" :key="i">{{ d }}</li></ul>
    </div>
    <table>
      <thead>
        <tr><th>裁决</th><th>原始入口</th><th>最终 URL</th><th>状态</th><th>跳数</th><th>问题</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="it in detail.items" :key="it.source_norm">
          <td><VerdictBadge :verdict="it.verdict" :label="verdictLabel" /></td>
          <td class="mono">{{ it.source_raw }}</td>
          <td class="mono">{{ it.final_url_raw || '—' }}</td>
          <td>{{ it.final_status ?? '—' }}</td>
          <td>{{ it.hops }}</td>
          <td>
            <ul v-if="it.issues?.length" class="issues"><li v-for="(x, k) in it.issues" :key="k">{{ x }}</li></ul>
            <span v-else class="muted small">无</span>
          </td>
          <td><a href="#" @click.prevent="showHops(it)">逐跳证据</a></td>
        </tr>
      </tbody>
    </table>

    <div v-if="hops" class="panel" style="background:var(--panel2)">
      <h3>运行 #{{ detail.run.id }} 冻结的逐跳链：{{ hopsKey }}</h3>
      <table>
        <thead><tr><th>#</th><th>请求 URL（规范化）</th><th>状态</th><th>Location（原样）</th><th>错误/备注</th></tr></thead>
        <tbody>
          <tr v-for="h in hops" :key="h.index">
            <td>{{ h.index }}</td>
            <td class="mono">{{ h.url_norm }}</td>
            <td>{{ h.status ?? '—' }}</td>
            <td class="mono">{{ h.location_raw || '—' }}</td>
            <td class="mono">{{ h.fetch_error || h.note || '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>运行对比（仅兼容运行可给出业务差异）</h2>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:2">
        <span>基准运行（base）</span>
        <select v-model.number="cmpBase">
          <option v-for="r in runs" :key="r.id" :value="r.id">#{{ r.id }} · {{ r.status_label }} · {{ fmt(r.started_at) }}</option>
        </select>
      </label>
      <label class="field" style="flex:2">
        <span>对比运行（head）</span>
        <select v-model.number="cmpHead">
          <option v-for="r in runs" :key="r.id" :value="r.id">#{{ r.id }} · {{ r.status_label }} · {{ fmt(r.started_at) }}</option>
        </select>
      </label>
      <div style="flex:1">
        <button class="btn secondary" :disabled="!cmpBase || !cmpHead || cmpBase === cmpHead" @click="compare">比较</button>
      </div>
    </div>

    <div v-if="cmp">
      <div v-if="!cmp.compatible" class="callout bad">
        <b>⛔ 输入不兼容，无法给出业务差异结论：</b>
        <ul class="issues"><li v-for="(r, i) in cmp.reasons" :key="i">{{ r }}</li></ul>
        <div class="small muted">旧运行不能用来给新方案放行；请在当前映射与策略下执行一次完整验证。</div>
      </div>
      <template v-else>
        <div v-for="(w, i) in cmp.warnings" :key="i" class="callout bad small">⚠️ {{ w }}</div>
        <div v-if="cmp.stable" class="callout ok">
          ✅ <b>稳定：运行 #{{ cmp.base.id }} 与 #{{ cmp.head.id }} 无业务变化</b>
          （无新增失败、无修复、无回退、无不可比较项）。
        </div>
        <div v-else class="callout">
          差异：已修复 <b>{{ cmp.counts.fixed }}</b> · 状态回退 <b>{{ cmp.counts.regressed }}</b> ·
          新增失败 <b>{{ cmp.counts.new_failures }}</b> · 不可比较 <b>{{ cmp.counts.not_comparable }}</b>
          （持续通过 {{ cmp.counts.unchanged_good }}，持续失败 {{ cmp.counts.unchanged_bad }}）
        </div>
        <div style="margin:8px 0">
          <a :href="api.compareReportUrl(cmp.base.id, cmp.head.id)" target="_blank">导出对比报告（Markdown，含运行标识与输入摘要）</a>
        </div>
        <template v-for="sec in cmpSections" :key="sec.key">
          <div v-if="cmp.buckets[sec.key].length" class="panel" style="background:var(--panel2)">
            <h3>{{ sec.title }}（{{ cmp.buckets[sec.key].length }}）</h3>
            <table>
              <thead><tr><th>原始入口</th><th>归一化键</th><th>#{{ cmp.base.id }} 裁决</th><th>#{{ cmp.head.id }} 裁决</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="e in cmp.buckets[sec.key]" :key="e.source_norm">
                  <td class="mono">{{ e.source_raw }}</td>
                  <td class="mono">{{ e.source_norm }}</td>
                  <td><VerdictBadge :verdict="e.base_verdict" :label="verdictLabel" /></td>
                  <td><VerdictBadge :verdict="e.head_verdict" :label="verdictLabel" /></td>
                  <td class="small">{{ e.reason || (e.head_issues || []).join('；') || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.vue';

const runs = ref([]);
const verdictLabel = ref({});
const starting = ref(false);
const runningId = ref(null);
const detail = ref(null);
const hops = ref(null);
const hopsKey = ref('');
const cmpBase = ref(null);
const cmpHead = ref(null);
const cmp = ref(null);

const cmpSections = [
  { key: 'fixed', title: '✅ 已修复（失败 → 通过）' },
  { key: 'regressed', title: '🔻 状态回退（通过 → 失败）' },
  { key: 'new_failures', title: '🆕 新增失败（基准未覆盖，新运行即失败）' },
  { key: 'not_comparable', title: '⚠️ 不可比较项' },
];

const baseline = computed(() => runs.value.find((r) => r.is_current_baseline) ?? null);

let pollTimer = null;
async function load() {
  const d = await api.runs();
  runs.value = d.runs;
  verdictLabel.value = d.verdictLabel;
  const running = d.runs.find((r) => r.status === 'running');
  runningId.value = running?.id ?? null;
  if (runningId.value && !pollTimer) startPolling();
  if (!runningId.value && pollTimer) stopPolling();
  if (detail.value) await open(detail.value.run.id, true);
}
function startPolling() {
  pollTimer = setInterval(load, 800);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
async function start() {
  starting.value = true;
  try {
    const r = await api.startRun({});
    runningId.value = r.id;
    startPolling();
    await load();
  } catch (e) {
    alert(e.message);
  } finally {
    starting.value = false;
  }
}
async function cancel(id) {
  await api.cancelRun(id);
  await load();
}
async function open(id, keepHops = false) {
  detail.value = await api.run(id);
  if (!keepHops) { hops.value = null; hopsKey.value = ''; }
}
async function showHops(it) {
  const r = await api.runHops(detail.value.run.id, it.source_norm);
  hops.value = r.hops_detail;
  hopsKey.value = it.source_norm;
}
async function compare() {
  cmp.value = await api.compareRuns(cmpBase.value, cmpHead.value);
}
function statusCls(s) {
  return s === 'complete' ? 'ok' : s === 'running' ? 'warn' : 'bad';
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
onMounted(load);
onUnmounted(stopPolling);
</script>

<style scoped>
tr.selected td { background: rgba(77, 163, 255, .06); }
</style>
