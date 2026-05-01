const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: Georgia, serif; background: #faf7f2; color: #2c2416; margin: 0; padding: 1.5rem; }
  a { color: #1d4b3e; }
  h1 { font-size: 1.4rem; margin: 0; }
  .page-header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
  .muted { font-size: 0.85rem; color: #5c5346; }
  .error-box { background: #fdf0ee; border: 1px solid #d9534f; border-radius: 4px; padding: 0.75rem 1rem; color: #a02020; margin-bottom: 1rem; }
  .info-box  { background: #f5f0e8; border: 1px solid #c9b99a; border-radius: 4px; padding: 0.75rem 1rem; color: #5c5346; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; border-bottom: 2px solid #c9b99a; padding: 0.35rem 0.6rem; font-weight: 600; white-space: nowrap; }
  td { border-bottom: 1px solid #e5ddd0; padding: 0.35rem 0.6rem; vertical-align: top; }
  tr:hover td { background: #f5f0e8; }
  .mono { font-family: monospace; font-size: 0.82rem; }
  .badge { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 3px; font-size: 0.78rem; font-weight: 600; }
  .badge-warn    { background: #fff3cd; color: #856404; }
  .badge-error   { background: #f8d7da; color: #842029; }
  .badge-ok      { background: #d1e7dd; color: #0a3622; }
  .badge-neutral { background: #e2e8f0; color: #4a4a4a; }
  .btn { border: none; border-radius: 4px; padding: 0.5rem 1.2rem; font-size: 0.9rem; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #1d4b3e; color: #fff; }
  .btn-danger  { background: #a02020; color: #fff; }
  .btn-row { display: flex; gap: 0.75rem; align-items: center; margin-top: 0.75rem; }
  .status-bar { display: flex; gap: 1.5rem; margin: 0.75rem 0 1.5rem; }
  .stat { text-align: center; }
  .stat-num   { font-size: 1.8rem; font-weight: 700; line-height: 1; }
  .stat-label { font-size: 0.75rem; color: #7a6e62; text-transform: uppercase; letter-spacing: 0.04em; }
  .num-ok      { color: #0a6e3a; }
  .num-err     { color: #a02020; }
  .num-pending { color: #856404; }
  .review-panel { background: #f5f0e8; border: 1px solid #c9b99a; border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
  .review-panel h2 { margin: 0 0 0.75rem; font-size: 1rem; }
  textarea { width: 100%; border: 1px solid #c9b99a; border-radius: 4px; padding: 0.5rem; font-family: Georgia, serif; font-size: 0.9rem; resize: vertical; background: #fffdf8; }
  .http-ok      { color: #0a6e3a; font-weight: 700; }
  .http-err     { color: #a02020; font-weight: 700; }
  .http-pending { color: #856404; }
  .ct-warn      { color: #856404; font-weight: 600; }
  td.overflow   { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #7a6e62; font-style: italic; }
`;

const HEAD = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>${CSS}</style>
</head>
<body>`;

const FOOT = `</body></html>`;

// ── Error page ────────────────────────────────────────────────────────────────

export function errorHtml(message: string, status = 400): Response {
  const html = HEAD('Error') + `
<div class="page-header"><h1>Error</h1></div>
<div class="error-box">${message.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c] ?? c))}</div>
<p><a href="/ui">← back to runs</a></p>
` + FOOT;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function runsListHtml(): Response {
  const html = HEAD('Agent Runs') + `
<div class="page-header">
  <h1>Agent Runs</h1>
</div>

<button class="btn btn-primary" id="start-btn" type="button">Start new run</button>
<span id="start-status" class="muted" style="margin-left:0.75rem"></span>

<div id="content" class="info-box" style="margin-top:1rem">Loading…</div>

<script>
(async function () {
  function badgeClass(status) {
    if (status.startsWith('awaiting_review')) return 'badge-warn';
    if (status === 'failed') return 'badge-error';
    if (status === 'published_draft') return 'badge-ok';
    return 'badge-neutral';
  }

  async function load() {
    const el = document.getElementById('content');
    try {
      const res = await fetch('/runs');
      if (res.status === 401) {
        window.location.assign('/ui/auth/login');
        return;
      }
      if (!res.ok) { el.innerHTML = '<span class="error-box">Error ' + res.status + '</span>'; return; }
      const data = await res.json();
      const runs = data.runs ?? [];
      if (runs.length === 0) { el.innerHTML = '<p class="empty">No runs yet.</p>'; return; }
      let rows = runs.map(r => \`<tr>
        <td class="mono"><a href="/ui/\${encodeURIComponent(r.id)}">\${r.id}</a></td>
        <td><span class="badge \${badgeClass(r.status)}">\${r.status.replace(/_/g,' ')}</span></td>
        <td>\${r.current_stage ?? '—'}</td>
        <td>\${new Date(r.started_at).toLocaleString()}</td>
        <td>\${new Date(r.updated_at).toLocaleString()}</td>
      </tr>\`).join('');
      el.innerHTML = '<table><thead><tr><th>Run ID</th><th>Status</th><th>Stage</th><th>Started</th><th>Updated</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) {
      el.innerHTML = '<span class="error-box">' + e.message + '</span>';
    }
  }

  document.getElementById('start-btn').addEventListener('click', async () => {
    const btn = document.getElementById('start-btn');
    const st  = document.getElementById('start-status');
    btn.disabled = true;
    st.textContent = 'Starting…';
    try {
      const res = await fetch('/runs/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (res.ok) { st.textContent = 'Started: ' + data.runId; setTimeout(() => load(), 1500); }
      else { st.textContent = 'Error: ' + (data.error ?? res.status); btn.disabled = false; }
    } catch (e) { st.textContent = e.message; btn.disabled = false; }
  });

  load();
})();
</script>
` + FOOT;

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ── Run detail ────────────────────────────────────────────────────────────────

export function runDetailHtml(runId: string): Response {
  const escaped = runId.replace(/[<>"'&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c] ?? c));
  const html = HEAD('Run Review') + `
<div class="page-header">
  <h1>Run Review</h1>
  <span class="muted mono">${escaped}</span>
  <a class="muted" href="/ui">← all runs</a>
</div>

<div id="stats"></div>
<div id="run-actions"></div>
<div id="review"></div>
<div id="feeds"></div>

<script>
(async function () {
  const runId = ${JSON.stringify(runId)};
  let refreshTimer = null;
  let loading = false;
  let ws = null;
  let wsConnected = false;
  let wsReconnectTimer = null;
  let stage2Initialized = false;
  const stage2Rows = new Map();

  function stopWsReconnect() {
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  }

  function scheduleWsReconnect(ms) {
    stopWsReconnect();
    wsReconnectTimer = setTimeout(() => {
      connectProgressSocket();
    }, ms);
  }

  function closeProgressSocket() {
    stopWsReconnect();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    wsConnected = false;
  }

  function connectProgressSocket() {
    if (ws) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = protocol + '//' + window.location.host + '/ui/ws/candidate-progress?runId=' + encodeURIComponent(runId);
    try {
      ws = new WebSocket(socketUrl);
      ws.addEventListener('open', () => {
        wsConnected = true;
        stopAutoRefresh();
      });
      ws.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.type === 'candidate-update' && payload?.runId === runId && payload?.candidate && typeof payload.candidate.id === 'number') {
            stage2Rows.set(payload.candidate.id, payload.candidate);
            patchStage2Row(payload.candidate);
            updateStage2StatsFromRows();
            if (typeof payload.pendingRemaining === 'number' && payload.pendingRemaining === 0) {
              void load();
            }
            return;
          }
        } catch {
          // Fallback to standard refresh if payload is malformed.
        }
        void load();
      });
      ws.addEventListener('close', () => {
        ws = null;
        wsConnected = false;
        scheduleWsReconnect(3000);
      });
      ws.addEventListener('error', () => {
        wsConnected = false;
        if (ws) {
          try { ws.close(); } catch {}
        }
      });
    } catch {
      ws = null;
      scheduleWsReconnect(3000);
    }
  }

  function stopAutoRefresh() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleAutoRefresh(ms) {
    stopAutoRefresh();
    refreshTimer = setTimeout(() => {
      void load();
    }, ms);
  }

  function httpClass(s) { if (s === null) return 'http-pending'; if (s >= 200 && s < 300) return 'http-ok'; return 'http-err'; }
  function esc(value) {
    return String(value ?? '').replace(/[<>'"&]/g, c => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c] ?? c));
  }
  function ctShort(ct) {
    if (!ct) return '—';
    if (ct.includes('xml'))  return 'XML';
    if (ct.includes('html')) return '<span class="ct-warn">HTML ⚠</span>';
    if (ct.includes('json')) return 'JSON';
    return ct.split(';')[0] ?? ct;
  }
  function badgeClass(status) {
    if (!status) return 'badge-neutral';
    if (status.startsWith('awaiting_review')) return 'badge-warn';
    if (status === 'failed') return 'badge-error';
    if (status === 'published_draft') return 'badge-ok';
    return 'badge-neutral';
  }

  function safeDecisionLabel(row) {
    if (!row?.decision_code) {
      return row?.article_status ? ('status_' + String(row.article_status)) : 'pending';
    }
    return String(row.decision_code);
  }

  function safeDecisionDetail(row) {
    if (!row?.decision_detail) {
      return '';
    }
    if (typeof row.decision_detail !== 'string') {
      return String(row.decision_detail);
    }
    try {
      const parsed = JSON.parse(row.decision_detail);
      return JSON.stringify(parsed);
    } catch {
      return row.decision_detail;
    }
  }

  function stage2RowHtml(r) {
    const href = r.article_r2_key
      ? ('/runs/' + encodeURIComponent(runId) + '/stages/candidate_extract/cache/' + encodeURIComponent(String(r.id)))
      : esc(r.resolved_url ?? r.raw_url);
    const resolve = esc(r.resolve_status ?? (r.requires_url_resolution === 1 ? 'pending' : 'skipped'));
    const articleClass = r.article_status === 'ok' || r.article_status === 'cached'
      ? 'http-ok'
      : (r.article_status === 'blocked' || r.article_status === 'failed' || r.article_status === 'filtered' ? 'http-err' : 'http-pending');
    const decisionLabel = safeDecisionLabel(r);
    const decisionDetail = safeDecisionDetail(r);

    return '<tr id="candidate-row-' + String(r.id) + '">' +
      '<td class="mono">' + String(r.id) + '</td>' +
      '<td class="overflow" title="' + esc(r.resolved_url ?? r.raw_url) + '"><a href="' + href + '" target="_blank" rel="noopener noreferrer">' + esc(r.title ?? r.resolved_url ?? r.raw_url) + '</a></td>' +
      '<td>' + esc(r.feed_title ?? r.feed_id ?? '—') + '</td>' +
      '<td>' + esc(r.source_category ?? '—') + '</td>' +
      '<td>' + esc(r.source_language ?? '—') + '</td>' +
      '<td>' + resolve + '</td>' +
      '<td class="' + articleClass + '">' + esc(r.article_status ?? 'pending') + '</td>' +
      '<td>' + esc(r.article_http_status ?? '—') + '</td>' +
        '<td class="overflow" title="' + esc(decisionDetail) + '">' + esc(decisionLabel) + '</td>' +
      '<td>' + esc(r.pub_date ? new Date(r.pub_date).toLocaleString() : '—') + '</td>' +
      '<td>' + (r.excluded === 1 ? 'yes' : 'no') + '</td>' +
      '</tr>';
  }

  function patchStage2Row(r) {
    const emptyRow = document.getElementById('candidate-empty-row');
    if (emptyRow) {
      emptyRow.remove();
    }

    const existing = document.getElementById('candidate-row-' + String(r.id));
    if (existing) {
      existing.outerHTML = stage2RowHtml(r);
      return;
    }

    const body = document.getElementById('stage2-table-body');
    if (body) {
      body.insertAdjacentHTML('beforeend', stage2RowHtml(r));
    }
  }

  function renderStage2TableOnce(results) {
    stage2Rows.clear();
    for (const r of results) {
      stage2Rows.set(r.id, r);
    }

    const rows = Array.from(stage2Rows.values())
      .sort((a, b) => a.id - b.id)
      .map((r) => stage2RowHtml(r))
      .join('');

    const feedsEl = document.getElementById('feeds');
    feedsEl.innerHTML = '<table><thead><tr><th>ID</th><th>Candidate</th><th>Source</th><th>Category</th><th>Lang</th><th>Resolve</th><th>Article</th><th>HTTP</th><th>Decision</th><th>Published</th><th>Excluded</th></tr></thead><tbody id="stage2-table-body">' + rows + '</tbody></table>';
    if (!rows) {
      const body = document.getElementById('stage2-table-body');
      if (body) {
        body.insertAdjacentHTML('beforeend', '<tr id="candidate-empty-row"><td colspan="11" class="empty">No candidates extracted for this run yet.</td></tr>');
      }
    }
    stage2Initialized = true;
  }

  function updateStage2StatsFromRows() {
    const statsEl = document.getElementById('stats');
    const values = Array.from(stage2Rows.values());
    if (values.length === 0) {
      return;
    }

    const unresolved = values.filter(r => r.resolve_status !== 'ok' && r.requires_url_resolution === 1).length;
    const okArticles = values.filter(r => r.article_status === 'ok').length;
    const cachedArticles = values.filter(r => r.article_status === 'cached').length;
    const blockedArticles = values.filter(r => r.article_status === 'blocked').length;
    const failedArticles = values.filter(r => r.article_status === 'failed').length;
    const filteredArticles = values.filter(r => r.article_status === 'filtered').length;
    const excluded = values.filter(r => r.excluded === 1).length;

    const runBadge = document.getElementById('run-status-badge');
    const runStatus = runBadge ? runBadge.textContent : 'started';

    statsEl.innerHTML =
      '<div class="status-bar">' +
      '<div class="stat"><div class="stat-num">' + String(values.length) + '</div><div class="stat-label">Candidates</div></div>' +
      '<div class="stat"><div class="stat-num num-pending">' + String(unresolved) + '</div><div class="stat-label">Need URL Resolve</div></div>' +
      '<div class="stat"><div class="stat-num num-ok">' + String(okArticles + cachedArticles) + '</div><div class="stat-label">Article Ready</div></div>' +
      '<div class="stat"><div class="stat-num num-err">' + String(blockedArticles + failedArticles + filteredArticles) + '</div><div class="stat-label">Rejected/Errors</div></div>' +
      '<div class="stat"><div class="stat-num">' + String(excluded) + '</div><div class="stat-label">Excluded</div></div>' +
      '</div>' +
      '<p class="muted">' +
      '<span class="badge badge-ok">ok ' + String(okArticles) + '</span>' +
      '<span class="badge badge-neutral" style="margin-left:0.35rem">cached ' + String(cachedArticles) + '</span>' +
      '<span class="badge badge-error" style="margin-left:0.35rem">filtered ' + String(filteredArticles) + '</span>' +
      '<span class="badge badge-error" style="margin-left:0.35rem">blocked ' + String(blockedArticles) + '</span>' +
      '<span class="badge badge-error" style="margin-left:0.35rem">failed ' + String(failedArticles) + '</span>' +
      '</p>' +
      '<p class="muted">Stage: Stage 2 candidate extract</p>' +
      '<p class="muted">Status: <span class="badge ' + badgeClass((runStatus || '').replace(/ /g, '_')) + '" id="run-status-badge">' + esc(runStatus || 'started') + '</span></p>';
  }

  async function load() {
    if (loading) {
      return;
    }
    loading = true;

    const statsEl  = document.getElementById('stats');
    const actionsEl = document.getElementById('run-actions');
    const reviewEl = document.getElementById('review');
    const feedsEl  = document.getElementById('feeds');

    try {
      const runRes = await fetch('/runs/' + encodeURIComponent(runId));
      if (runRes.status === 401) {
        window.location.assign('/ui/auth/login');
        return;
      }
      if (!runRes.ok) { statsEl.innerHTML = '<div class="error-box">Error ' + runRes.status + '</div>'; return; }

      const runData = await runRes.json();
      const run = runData.run ?? null;
      const shouldAutoRefresh = Boolean(run?.status === 'started' || run?.status === 'no_stories');
      const stageName = run?.current_stage === 'candidate_extract' || run?.status === 'awaiting_review_candidate_extract'
        ? 'candidate_extract'
        : 'feed_fetch';

      const isStage1 = stageName === 'feed_fetch';
      const isStage2 = stageName === 'candidate_extract';
      let results = [];

      if (!(isStage2 && stage2Initialized)) {
        const res = await fetch('/runs/' + encodeURIComponent(runId) + '/stages/' + stageName);
        if (res.status === 401) {
          window.location.assign('/ui/auth/login');
          return;
        }
        if (!res.ok) { statsEl.innerHTML = '<div class="error-box">Error ' + res.status + '</div>'; return; }

        const data   = await res.json();
        results = data.results ?? [];
      } else {
        results = Array.from(stage2Rows.values());
      }

      if (isStage1) {
        const fetched = results.filter(r => r.status !== null && r.status >= 200 && r.status < 300).length;
        const failed  = results.filter(r => r.status !== null && (r.status < 200 || r.status >= 300)).length;
        const pending = results.filter(r => r.status === null).length;

        statsEl.innerHTML = run ?
          \`<div class="status-bar">
            <div class="stat"><div class="stat-num num-ok">\${fetched}</div><div class="stat-label">Fetched</div></div>
            <div class="stat"><div class="stat-num num-err">\${failed}</div><div class="stat-label">Failed</div></div>
            <div class="stat"><div class="stat-num num-pending">\${pending}</div><div class="stat-label">Not cached</div></div>
            <div class="stat"><div class="stat-num">\${results.length}</div><div class="stat-label">Total</div></div>
          </div>
          <p class="muted">Stage: Stage 1 feed fetch</p>
          <p class="muted">Status: <span class="badge \${badgeClass(run.status)}" id="run-status-badge">\${(run.status ?? '—').replace(/_/g,' ')}</span></p>
        \` : '';
      } else {
        const unresolved = results.filter(r => r.resolve_status !== 'ok' && r.requires_url_resolution === 1).length;
        const okArticles = results.filter(r => r.article_status === 'ok').length;
        const cachedArticles = results.filter(r => r.article_status === 'cached').length;
        const blockedArticles = results.filter(r => r.article_status === 'blocked').length;
        const failedArticles = results.filter(r => r.article_status === 'failed').length;
        const filteredArticles = results.filter(r => r.article_status === 'filtered').length;
        const excluded = results.filter(r => r.excluded === 1).length;

        statsEl.innerHTML = run ?
          \`<div class="status-bar">
            <div class="stat"><div class="stat-num">\${results.length}</div><div class="stat-label">Candidates</div></div>
            <div class="stat"><div class="stat-num num-pending">\${unresolved}</div><div class="stat-label">Need URL Resolve</div></div>
            <div class="stat"><div class="stat-num num-ok">\${okArticles + cachedArticles}</div><div class="stat-label">Article Ready</div></div>
            <div class="stat"><div class="stat-num num-err">\${blockedArticles + failedArticles + filteredArticles}</div><div class="stat-label">Rejected/Errors</div></div>
            <div class="stat"><div class="stat-num">\${excluded}</div><div class="stat-label">Excluded</div></div>
          </div>
          <p class="muted">
            <span class="badge badge-ok">ok \${okArticles}</span>
            <span class="badge badge-neutral" style="margin-left:0.35rem">cached \${cachedArticles}</span>
            <span class="badge badge-error" style="margin-left:0.35rem">filtered \${filteredArticles}</span>
            <span class="badge badge-error" style="margin-left:0.35rem">blocked \${blockedArticles}</span>
            <span class="badge badge-error" style="margin-left:0.35rem">failed \${failedArticles}</span>
          </p>
          <p class="muted">Stage: Stage 2 candidate extract</p>
          <p class="muted">Status: <span class="badge \${badgeClass(run.status)}" id="run-status-badge">\${(run.status ?? '—').replace(/_/g,' ')}</span></p>
        \` : '';
      }

      actionsEl.innerHTML = run ? \`
        <div class="review-panel">
          <h2>Run actions</h2>
          <p class="muted">Deleting a run removes run records and run-specific article blobs from R2. Shared Stage 1 feed cache snapshots are retained.</p>
          <div class="btn-row">
            <button class="btn btn-danger" id="btn-delete-run" type="button">Delete run</button>
            <span id="delete-status" class="muted"></span>
          </div>
        </div>
      \` : '';

      if (run) {
        document.getElementById('btn-delete-run')?.addEventListener('click', async () => {
          const confirmed = window.confirm('Delete this run? Shared Stage 1 feed cache will be kept.');
          if (!confirmed) {
            return;
          }

          const btn = document.getElementById('btn-delete-run');
          const st = document.getElementById('delete-status');
          btn.disabled = true;
          st.textContent = 'Deleting…';

          try {
            const res = await fetch('/runs/' + encodeURIComponent(runId) + '/delete', { method: 'POST' });
            const data = await res.json();
            if (!res.ok || data.deleted !== true) {
              st.textContent = 'Error: ' + (data.error ?? data.message ?? res.status);
              btn.disabled = false;
              return;
            }

            st.textContent = 'Deleted. Redirecting…';
            setTimeout(() => window.location.assign('/ui'), 700);
          } catch (e) {
            st.textContent = e.message;
            btn.disabled = false;
          }
        });
      }

      const isAwaiting = isStage1
        ? run?.status === 'awaiting_review_feed_fetch'
        : run?.status === 'awaiting_review_candidate_extract';

      if (isStage2 && run?.status === 'started') {
        connectProgressSocket();
      } else {
        closeProgressSocket();
      }
      reviewEl.innerHTML = isAwaiting ? \`
        <div class="review-panel">
          <h2>Approve or reject to continue</h2>
          <textarea id="notes" rows="2" placeholder="Optional notes…"></textarea>
          <div class="btn-row">
            <button class="btn btn-primary" id="btn-approve" type="button">\${isStage1 ? 'Approve → Stage 2' : 'Approve final stage'}</button>
            <button class="btn btn-danger"  id="btn-reject"  type="button">Reject</button>
            <span id="review-status" class="muted"></span>
          </div>
        </div>
      \` : '';

      if (isAwaiting) {
        stopAutoRefresh();
        async function submitReview(action) {
          const notes = document.getElementById('notes')?.value.trim() || null;
          const btnA  = document.getElementById('btn-approve');
          const btnR  = document.getElementById('btn-reject');
          const st    = document.getElementById('review-status');
          btnA.disabled = btnR.disabled = true;
          st.textContent = 'Submitting…';
          try {
            const r = await fetch('/runs/' + encodeURIComponent(runId) + '/stages/' + stageName + '/' + action, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ notes }),
            });
            const d = await r.json();
            if (r.ok) {
              st.textContent = action === 'approve'
                ? (isStage1 ? '✓ Approved — Stage 2 processing in background…' : '✓ Approved — run complete')
                : '✗ Rejected';
              setTimeout(() => window.location.reload(), 2000);
            } else {
              st.textContent = 'Error: ' + (d.error ?? r.status);
              btnA.disabled = btnR.disabled = false;
            }
          } catch (e) { st.textContent = e.message; btnA.disabled = btnR.disabled = false; }
        }
        document.getElementById('btn-approve').addEventListener('click', () => submitReview('approve'));
        document.getElementById('btn-reject').addEventListener('click',  () => submitReview('reject'));
      } else if (shouldAutoRefresh && !(isStage2 && wsConnected)) {
        scheduleAutoRefresh(4000);
      } else {
        stopAutoRefresh();
      }

      if (isStage1 && results.length > 0) {
        const rows = results.map(r => \`<tr>
          <td class="overflow" title="\${r.feed_url ?? ''}"><a href="\${r.r2_key ? ('/runs/' + encodeURIComponent(runId) + '/stages/feed_fetch/cache?u=' + encodeURIComponent(r.feed_url ?? '')) : (r.feed_url ?? '#')}" target="_blank" rel="noopener noreferrer">\${r.feed_title ?? r.feed_id}</a></td>
          <td>\${r.source_category ?? '—'}</td>
          <td>\${r.language ?? '—'}</td>
          <td class="\${httpClass(r.status)}">\${r.status ?? '—'}</td>
          <td>\${ctShort(r.content_type)}</td>
          <td>\${r.fetched_at ? new Date(r.fetched_at).toLocaleTimeString() : '—'}</td>
          <td>\${r.expires_at ? new Date(r.expires_at).toLocaleTimeString() : '—'}</td>
        </tr>\`).join('');
        feedsEl.innerHTML = '<table><thead><tr><th>Feed</th><th>Category</th><th>Lang</th><th>HTTP</th><th>Content-Type</th><th>Fetched</th><th>Expires</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }

      if (isStage2) {
        if (!stage2Initialized) {
          renderStage2TableOnce(results);
        }
      }
    } catch (e) {
      scheduleAutoRefresh(5000);
      document.getElementById('stats').innerHTML = '<div class="error-box">' + e.message + '</div>';
    } finally {
      loading = false;
    }
  }

  load();
})();
</script>
` + FOOT;

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
