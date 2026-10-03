<template>
  <div class="panel">
    <h2>迁移方案</h2>
    <p class="muted small">
      “纳入方案”只是 pending；证据取自当前<b>基线运行</b>（complete 且与当前映射/策略兼容的全量运行）。
      发布闸门拒绝任何 blocked/pending、未纳入的生效映射、未裁决歧义，
      以及“基线运行已不完整/不兼容/被更新运行取代”的方案。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>方案名称</span>
        <input v-model="newName" placeholder="例：2026 秋季栏目改版" />
      </label>
      <div style="flex:1">
        <button class="btn" @click="create">新建方案</button>
      </div>
    </div>
    <table style="margin-top:10px">
      <thead><tr><th>ID</th><th>名称</th><th>状态</th><th>条目</th><th>已验证</th><th>阻断</th><th>待验证</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in plans" :key="p.id">
          <td>{{ p.id }}</td><td>{{ p.name }}</td>
          <td><span class="badge" :class="p.status === 'published' ? 'ok' : 'neutral'">{{ statusText(p.status) }}</span></td>
          <td>{{ p.items }}</td><td>{{ p.verified }}</td>
          <td :style="Number(p.blocked) ? 'color:var(--bad)' : ''">{{ p.blocked }}</td>
          <td>{{ p.pending }}</td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(p.id)">查看</a> ·
            <a href="#" @click.prevent="build(p.id)">纳入全部生效映射</a> ·
            <a href="#" @click.prevent="publish(p.id)">尝试发布</a>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="detail">
    <h2>方案 #{{ detail.plan.id }}：{{ detail.plan.name }}（{{ statusText(detail.plan.status) }}）</h2>

    <div v-if="detail.baseline_run" class="callout" :class="detail.baseline_validity.valid ? 'ok' : 'bad'">
      <b>发布依据：基线运行 #{{ detail.baseline_run.id }}</b>
      （{{ detail.baseline_run.status_label }} · {{ fmt(detail.baseline_run.started_at) }} ·
      映射版本 {{ detail.baseline_run.mapping_version_short }}… · 策略版本 {{ detail.baseline_run.policy_version_short }}…）
      <span v-if="detail.baseline_run.is_current_baseline" class="badge ok">当前基线</span>
      <ul v-if="!detail.baseline_validity.valid" class="issues">
        <li v-for="(r, i) in detail.baseline_validity.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>
    <div v-else class="callout bad">
      方案尚未基于任何完整验证运行构建——先执行一次全量验证运行，再“纳入全部生效映射”。
    </div>

    <div v-if="lastPublish && !lastPublish.published">
      <div class="callout bad">
        <b>发布被拒绝，受影响链接：</b>
        <table style="margin-top:8px">
          <thead><tr><th>旧址</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="(b, i) in lastPublish.blockers" :key="i">
              <td class="mono">{{ b.source }}</td><td>{{ b.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else-if="lastPublish?.published" class="callout ok">
      ✅ 已发布。每条链接均有最终页面状态与逐跳证据（基线运行 #{{ detail.plan.baseline_run_id }}）。
    </div>
    <table>
      <thead><tr><th>状态</th><th>旧址</th><th>计划目标（含保留的追踪参数）</th><th>裁决证据</th></tr></thead>
      <tbody>
        <tr v-for="it in detail.items" :key="it.id">
          <td>
            <span class="badge" :class="it.item_status === 'verified' ? 'ok' : it.item_status === 'blocked' ? 'bad' : 'neutral'">
              {{ it.item_status === 'verified' ? '已验证' : it.item_status === 'blocked' ? '阻断' : '仅填表' }}
            </span>
          </td>
          <td class="mono">{{ it.source_raw }}</td>
          <td class="mono">{{ it.evidence?.proposed_redirect_url || '（已删除，返回 410/404）' }}</td>
          <td class="small">
            <div>最终状态：{{ it.evidence?.final_status ?? '—' }}；跳数：{{ it.evidence?.hops ?? '—' }}<template v-if="it.evidence?.run_id">；运行 #{{ it.evidence.run_id }}</template></div>
            <ul v-if="it.evidence?.issues?.length" class="issues">
              <li v-for="(x, k) in it.evidence.issues" :key="k">{{ x }}</li>
            </ul>
          </td>
        </tr>
      </tbody>
    </table>

    <h3>运行链（为什么某个运行不可作为基线，一目了然）</h3>
    <table>
      <thead>
        <tr><th>运行</th><th>终态</th><th>范围</th><th>映射版本</th><th>策略版本</th><th>开始时间</th><th>基线资格</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in detail.run_chain" :key="r.id">
          <td>
            #{{ r.id }}
            <span v-if="r.id === detail.plan.baseline_run_id" class="badge neutral">本方案依据</span>
            <span v-if="r.is_current_baseline" class="badge ok">当前基线</span>
          </td>
          <td><span class="badge" :class="r.status === 'complete' ? 'ok' : r.status === 'running' ? 'warn' : 'bad'">{{ r.status_label }}</span></td>
          <td>{{ r.scope === 'all' ? '全量' : '局部' }}</td>
          <td class="mono">{{ r.mapping_version_short }}…</td>
          <td class="mono">{{ r.policy_version_short }}…</td>
          <td class="small">{{ fmt(r.started_at) }}</td>
          <td class="small">
            <span v-if="r.baseline_eligibility.eligible" class="badge ok">可作基线</span>
            <ul v-else class="issues">
              <li v-for="(x, i) in r.baseline_eligibility.reasons" :key="i">{{ x }}</li>
            </ul>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
const props = defineProps({ refreshKey: Number });

const plans = ref([]);
const newName = ref('');
const detail = ref(null);
const lastPublish = ref(null);

async function load() { plans.value = await api.plans(); if (detail.value) await open(detail.value.plan.id); }
async function create() {
  if (!newName.value.trim()) return;
  await api.createPlan(newName.value.trim());
  newName.value = '';
  await load();
}
async function open(id) { detail.value = await api.plan(id); lastPublish.value = null; }
async function build(id) {
  const r = await api.buildPlan(id);
  alert(r.warning
    ? `已纳入 ${r.built} 条生效映射。⚠️ ${r.warning}`
    : `已纳入 ${r.built} 条生效映射（证据来自基线运行 #${r.baseline_run_id}）`);
  await load();
}
async function publish(id) {
  lastPublish.value = await api.publishPlan(id);
  await load();
}
function statusText(s) {
  return { draft: '草稿', ready: '就绪', published: '已发布' }[s] || s;
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }
watch(() => props.refreshKey, load);
onMounted(load);
</script>
