<template>
  <div class="panel">
    <h2>版本化运行历史 —— 每次验证冻结输入版本，终态可审计</h2>
    <p class="muted small">
      每次运行冻结：输入映射版本（指纹）、规范化/白名单策略（指纹+快照）、选择范围、逐跳链与最终裁决。
      只有 <b>complete + 全量 + 与当前输入兼容</b> 的运行才能作为发布基线；
      取消 / 超时 / 局部失败的运行保留诊断，但绝不顶替上一个完整基线。
    </p>
    <div class="callout" :class="baselineId ? 'ok' : 'bad'">
      <template v-if="baselineId">
        当前发布基线：<b>运行 #{{ baselineId }}</b>
        <span class="muted small">（映射指纹 {{ current.mappingFingerprint }} · 策略指纹 {{ current.policyFingerprint }}）</span>
      </template>
      <template v-else>
        <b>当前没有可用基线运行：</b>
        <ul class="issues" style="margin-top:4px">
          <li v-for="(r, i) in baselineReasons" :key="i">{{ r }}</li>
        </ul>
      </template>
    </div>
    <table style="margin-top:10px">
      <thead>
        <tr>
          <th>#</th><th>开始时间</th><th>终态</th><th>范围</th><th>裁决统计</th>
          <th>映射指纹</th><th>策略指纹</th><th>与当前输入</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in runs" :key="r.id">
          <td>
            {{ r.id }}
            <span v-if="r.is_baseline" class="badge ok">基线</span>
          </td>
          <td class="small">{{ fmt(r.started_at) }}</td>
          <td>
            <span class="badge" :class="statusCls(r.status)">{{ statusLabel[r.status] || r.status }}</span>
          </td>
          <td>{{ r.scope === 'all' ? '全量' : '单键' }}</td>
          <td class="small mono">{{ totalsText(r.totals) }}</td>
          <td class="mono small">{{ r.mapping_fingerprint }}</td>
          <td class="mono small">{{ r.policy_fingerprint }}</td>
          <td>
            <span v-if="r.compatible_with_current" class="badge ok">兼容</span>
            <span v-else class="badge bad" :title="(r.incompatibility_reasons || []).join('\n')">不兼容</span>
          </td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(r.id)">详情</a>
            <template v-if="r.status === 'running'"> · <a href="#" @click.prevent="cancel(r.id)">取消</a></template>
            · <a :href="reportUrl(r.id)" target="_blank">导出</a>
            · <a href="#" @click.prevent="pick(r.id)">比较</a>
          </td>
        </tr>
        <tr v-if="!runs.length"><td colspan="9" class="muted">还没有验证运行</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="detail">
    <h2>
      运行 #{{ detail.id }} 详情
      <span class="badge" :class="statusCls(detail.status)">{{ detail.status_label }}</span>
      <span v-if="detail.is_baseline" class="badge ok">当前基线</span>
    </h2>
    <div v-if="!detail.compatible_with_current" class="callout bad">
      <b>该运行与当前输入不兼容，不能作为发布依据：</b>
      <ul class="issues"><li v-for="(r, i) in detail.incompatibility_reasons" :key="i">{{ r }}</li></ul>
    </div>
    <div v-else-if="!detail.baseline_eligible && detail.status !== 'complete'" class="callout bad">
      <b>该运行未完整（{{ detail.status_label }}），只保留诊断，不作为发布基线。</b>
    </div>
    <div v-if="detail.diagnostics && detail.diagnostics.length" class="callout bad">
      <b>诊断：</b>
      <ul class="issues">
        <li v-for="(d, i) in detail.diagnostics" :key="i">[{{ d.level }}] {{ d.message }}</li>
      </ul>
    </div>
    <h3>输入摘要（运行开始时冻结）</h3>
    <table>
      <tbody>
        <tr><td>映射指纹</td><td class="mono">{{ detail.mapping_fingerprint }}</td>
            <td>生效映射</td><td>{{ detail.mapping_summary?.total }} 条（生效 {{ detail.mapping_summary?.active }} / 冲突 {{ detail.mapping_summary?.conflicted }} / 录入 {{ detail.mapping_summary?.inputs }}）</td></tr>
        <tr><td>策略指纹</td><td class="mono">{{ detail.policy_fingerprint }}</td>
            <td>白名单</td><td class="mono">{{ detail.policy_snapshot?.allowlist?.scheme }}//{{ detail.policy_snapshot?.allowlist?.host }}:{{ detail.policy_snapshot?.allowlist?.port }}</td></tr>
        <tr><td>尾斜杠</td><td class="mono">{{ detail.policy_snapshot?.normalize?.tailSlashMode }}</td>
            <td>爬取预算</td><td>≤{{ detail.policy_snapshot?.crawl?.maxRedirects }} 跳 · 超时 {{ detail.policy_snapshot?.crawl?.timeoutMs }}ms</td></tr>
        <tr><td>追踪参数</td><td class="mono" colspan="3">{{ (detail.policy_snapshot?.normalize?.trackerParams || []).join(', ') }}</td></tr>
      </tbody>
    </table>
    <h3>逐条裁决（{{ verdicts.length }}）</h3>
    <table>
      <thead><tr><th>裁决</th><th>旧址</th><th>最终状态</th><th>跳数</th><th>问题</th><th></th></tr></thead>
      <tbody>
        <tr v-for="v in verdicts" :key="v.source_norm">
          <td><VerdictBadge :verdict="v.verdict" :label="verdictLabel" /></td>
          <td class="mono">{{ v.source_raw }}</td>
          <td>{{ v.final_status ?? '—' }}</td>
          <td>{{ v.hops }}</td>
          <td class="small">
            <ul v-if="v.issues && v.issues.length" class="issues"><li v-for="(x, k) in v.issues" :key="k">{{ x }}</li></ul>
            <span v-else class="muted">无</span>
          </td>
          <td><a href="#" @click.prevent="showHops(v.source_norm)">逐跳证据</a></td>
        </tr>
      </tbody>
    </table>
    <div v-if="hops.length">
      <h3>逐跳证据：{{ hopsKey }}（运行 #{{ detail.id }}）</h3>
      <table>
        <thead><tr><th>#</th><th>请求 URL（规范化）</th><th>状态</th><th>Location（原样）</th><th>错误</th></tr></thead>
        <tbody>
          <tr v-for="h in hops" :key="h.hop_index">
            <td>{{ h.hop_index }}</td>
            <td class="mono">{{ h.url_norm }}</td>
            <td>{{ h.status_code ?? '—' }}</td>
            <td class="mono">{{ h.location_raw || '—' }}</td>
            <td class="mono">{{ h.fetch_error || '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>运行比较（同一原始入口 + 规范化键对齐）</h2>
    <div class="row" style="align-items:flex-end">
      <label class="field"><span>运行 A（较早 / 基线）</span>
        <select v-model.number="cmpA">
          <option :value="null">— 选择 —</option>
          <option v-for="r in runsDesc" :key="'a' + r.id" :value="r.id">#{{ r.id }} · {{ statusLabel[r.status] }} · {{ fmt(r.started_at) }}</option>
        </select>
      </label>
      <label class="field"><span>运行 B（较晚 / 候选）</span>
        <select v-model.number="cmpB">
          <option :value="null">— 选择 —</option>
          <option v-for="r in runsDesc" :key="'b' + r.id" :value="r.id">#{{ r.id }} · {{ statusLabel[r.status] }} · {{ fmt(r.started_at) }}</option>
        </select>
      </label>
      <div style="flex:1">
        <button class="btn" :disabled="!cmpA || !cmpB" @click="doCompare">比较</button>
        <a v-if="cmpA && cmpB" class="btn secondary" style="margin-left:8px;padding:7px 16px;border-radius:6px"
           :href="compareReportUrl" target="_blank">导出比较报告</a>
      </div>
    </div>

    <div v-if="cmp">
      <div v-if="!cmp.compatible" class="callout bad">
        <b>⛔ 输入不兼容，无法比较——旧 run 不能用来给新方案放行：</b>
        <ul class="issues"><li v-for="(r, i) in cmp.reasons" :key="i">{{ r }}</li></ul>
      </div>
      <template v-else>
        <div v-if="cmp.warnings && cmp.warnings.length" class="callout" style="border-color:var(--warn)">
          <b>注意：</b>{{ cmp.warnings.join('；') }}
        </div>
        <div class="kpi" style="margin-top:10px">
          <div class="card"><div class="num" style="color:var(--bad)">{{ cmp.summary.new_failures }}</div><div class="lbl">新增失败</div></div>
          <div class="card"><div class="num" style="color:var(--ok)">{{ cmp.summary.fixed }}</div><div class="lbl">已修复</div></div>
          <div class="card"><div class="num" style="color:var(--warn)">{{ cmp.summary.regressed }}</div><div class="lbl">状态回退</div></div>
          <div class="card"><div class="num">{{ cmp.summary.changed }}</div><div class="lbl">通过但证据变化</div></div>
          <div class="card"><div class="num">{{ cmp.summary.unchanged }}</div><div class="lbl">无业务变化</div></div>
          <div class="card"><div class="num" style="color:var(--warn)">{{ cmp.summary.incomparable }}</div><div class="lbl">不可比较</div></div>
        </div>
        <div v-if="stable" class="callout ok" style="margin-top:10px">
          ✅ 两次完整运行结果稳定：无新增失败、无回退、无证据变化、无不可比较项。
        </div>
        <DiffTable title="🆕 新增失败" :rows="cmp.diff.new_failures" :label="verdictLabel" />
        <DiffTable title="✅ 已修复" :rows="cmp.diff.fixed" :label="verdictLabel" />
        <DiffTable title="↩️ 状态回退（仍未通过，但失败形态变化）" :rows="cmp.diff.regressed" :label="verdictLabel" />
        <DiffTable title="🔀 通过但证据变化" :rows="cmp.diff.changed" :label="verdictLabel" />
        <div v-if="cmp.diff.incomparable.length">
          <h3>⚠️ 不可比较项（{{ cmp.diff.incomparable.length }}）</h3>
          <table>
            <thead><tr><th>旧址</th><th>归一化键</th><th>原因</th></tr></thead>
            <tbody>
              <tr v-for="r in cmp.diff.incomparable" :key="r.source_norm">
                <td class="mono">{{ r.source_raw }}</td>
                <td class="mono">{{ r.source_norm }}</td>
                <td class="small">{{ r.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.vue';

const props = defineProps({ refreshKey: Number });

const runs = ref([]);
const current = ref({});
const baselineId = ref(null);
const baselineReasons = ref([]);
const statusLabel = ref({});
const verdictLabel = ref({});
const detail = ref(null);
const verdicts = ref([]);
const hops = ref([]);
const hopsKey = ref('');
const cmpA = ref(null);
const cmpB = ref(null);
const cmp = ref(null);

const runsDesc = computed(() => runs.value);
const stable = computed(() => cmp.value?.compatible
  && cmp.value.summary.new_failures === 0
  && cmp.value.summary.fixed === 0
  && cmp.value.summary.regressed === 0
  && cmp.value.summary.changed === 0
  && cmp.value.summary.incomparable === 0);
const compareReportUrl = computed(() => api.compareReportUrl(cmpA.value, cmpB.value));

async function load() {
  const d = await api.runs();
  runs.value = d.runs;
  current.value = d.current;
  baselineId.value = d.baseline_run_id;
  baselineReasons.value = d.baseline_reasons;
  statusLabel.value = d.statusLabel;
  if (detail.value) await open(detail.value.id);
  const m = await api.mappings();
  verdictLabel.value = m.verdictLabel;
}
async function open(id) {
  detail.value = await api.run(id);
  verdicts.value = await api.runVerdicts(id);
  hops.value = [];
}
async function cancel(id) {
  await api.cancelRun(id);
  await load();
}
async function showHops(key) {
  hopsKey.value = key;
  try { hops.value = await api.runCrawl(detail.value.id, key); }
  catch { hops.value = []; }
}
function pick(id) {
  if (!cmpA.value || (cmpA.value && cmpB.value)) { cmpA.value = id; cmpB.value = null; }
  else cmpB.value = id;
}
async function doCompare() { cmp.value = await api.compareRuns(cmpA.value, cmpB.value); }
function statusCls(s) {
  return s === 'complete' ? 'ok' : s === 'running' ? 'warn' : 'bad';
}
function totalsText(t) {
  if (!t) return '—';
  return Object.entries(t).filter(([k]) => !k.startsWith('_'))
    .map(([k, n]) => `${verdictLabel.value[k] || k}×${n}`).join(' ') || '—';
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
function reportUrl(id) { return api.runReportUrl(id); }

// 差异桶表格（函数式小组件）
const DiffTable = (p) => {
  if (!p.rows?.length) return null;
  const cell = (v) => (v ? `${p.label?.[v.verdict] || v.verdict} / ${v.final_status ?? '—'}` : '—');
  return h('div', {}, [
    h('h3', `${p.title}（${p.rows.length}）`),
    h('table', {}, [
      h('thead', h('tr', [h('th', '旧址'), h('th', '归一化键'), h('th', '运行 A'), h('th', '运行 B'), h('th', '说明')])),
      h('tbody', p.rows.map((r) => h('tr', { key: r.source_norm }, [
        h('td', { class: 'mono' }, r.source_raw),
        h('td', { class: 'mono' }, r.source_norm),
        h('td', cell(r.a)),
        h('td', cell(r.b)),
        h('td', { class: 'small muted' }, r.note || ''),
      ]))),
    ]),
  ]);
};
DiffTable.props = { title: String, rows: Array, label: Object };

watch(() => props.refreshKey, load);
onMounted(load);
</script>
