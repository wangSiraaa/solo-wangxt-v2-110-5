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
  verify: (sourceNorm = null) =>
    fetch('/api/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceNorm ? { source_norm: sourceNorm } : {}),
    }).then(j),
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  runs: () => fetch('/api/runs').then(j),
  run: (id) => fetch(`/api/runs/${id}`).then(j),
  runVerdicts: (id) => fetch(`/api/runs/${id}/verdicts`).then(j),
  runCrawl: (id, key) =>
    fetch(`/api/runs/${id}/crawl/` + encodeURIComponent(key)).then(j),
  cancelRun: (id) => fetch(`/api/runs/${id}/cancel`, { method: 'POST' }).then(j),
  compareRuns: (a, b) => fetch(`/api/runs/compare?a=${a}&b=${b}`).then(j),
  runReportUrl: (id) => `/api/runs/${id}/report`,
  compareReportUrl: (a, b) => `/api/runs/compare/report?a=${a}&b=${b}`,
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
