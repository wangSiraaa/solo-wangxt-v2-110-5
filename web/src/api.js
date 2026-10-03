const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) =>
    fetch('/api/mappings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  normalize: (urls) =>
    fetch('/api/normalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).then(j),
  // 版本化验证运行
  runs: () => fetch('/api/runs').then(j),
  startRun: (payload = {}) =>
    fetch('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  run: (id) => fetch(`/api/runs/${id}`).then(j),
  cancelRun: (id) => fetch(`/api/runs/${id}/cancel`, { method: 'POST' }).then(j),
  runHops: (id, key) =>
    fetch(`/api/runs/${id}/hops/${encodeURIComponent(key)}`).then(j),
  compareRuns: (baseId, headId) =>
    fetch('/api/runs/compare', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_id: baseId, head_id: headId }),
    }).then(j),
  runReportUrl: (id) => `/api/runs/${id}/report`,
  compareReportUrl: (base, head) => `/api/runs/compare/report?base=${base}&head=${head}`,
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) =>
    fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j),
  buildPlan: (id) =>
    fetch(`/api/plans/${id}/build`, { method: 'POST' }).then(j),
  publishPlan: (id) =>
    fetch(`/api/plans/${id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),
};
