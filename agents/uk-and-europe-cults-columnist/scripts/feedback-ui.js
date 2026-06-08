/* Dynamic digest UI — loads view from /api/digest/view */
var CITATION_REPORT = { groups: [], markdown: '' };
var CITATION_BY_URL = {};
var API_BASE = window.location.origin;
var currentReport = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPublishedAt(iso) {
  if (!iso) return 'Unknown date';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toUTCString().replace(' GMT', ' UTC');
  } catch (_) {
    return iso;
  }
}

function storyLanguage(story) {
  const lang = (story.htmlLang || '').trim().toLowerCase();
  if (lang && lang !== 'en') return lang.split('-')[0];
  return 'en';
}

function shouldShowArchiveMirrors(story) {
  if (story.contentMirrorUrl) return true;
  const host = (story.host || '').toLowerCase();
  const paywall = ['telegraph.co.uk', 'ft.com', 'thetimes.co.uk', 'theguardian.com'];
  return paywall.some((h) => host === h || host.endsWith('.' + h));
}

function rebuildCitationIndex() {
  CITATION_BY_URL = {};
  (CITATION_REPORT.groups || []).forEach(function (group) {
    (group.sources || []).forEach(function (source) {
      CITATION_BY_URL[source.publisherUrl] = source.markdown;
    });
  });
}

function renderStoryCard(story) {
  const language = storyLanguage(story);
  const isNonEnglish = language !== 'en';
  const hostname = story.host || (function () { try { return new URL(story.url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  const logo = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(hostname) + '&sz=64';
  const citation = story.sourceCitation;
  const mirrors = story.archiveMirrorLinks || [];
  const showMirrors = shouldShowArchiveMirrors(story) && mirrors.length > 0;
  const auditData = story.classificationAudit ? escapeHtml(JSON.stringify(story.classificationAudit)) : '';
  const articleTextData = escapeHtml(story.articleText || '');
  const langAttr = isNonEnglish ? ' lang="' + escapeHtml(language) + '"' : '';
  const imageHtml = story.image
    ? '<img src="' + escapeHtml(story.image) + '" alt="' + escapeHtml(story.title) + '" class="story-image" loading="lazy" />'
    : '<div class="story-image fallback">No image found</div>';
  let mirrorHtml = '';
  if (showMirrors) {
    mirrorHtml = '<div class="archive-mirror-links"><span class="archive-mirror-label">Also via archive:</span>'
      + mirrors.map(function (m) {
        return '<a class="archive-mirror-link" href="' + escapeHtml(m.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(m.label) + '</a>';
      }).join('')
      + '</div>';
  }
  const accessible = citation && citation.paywalled && citation.accessibleUrl
    ? '<a class="read cite-accessible" href="' + escapeHtml(citation.accessibleUrl) + '" target="_blank" rel="noopener noreferrer">Accessible copy for citing</a>'
    : '';
  return '<article class="card" data-url="' + escapeHtml(story.url) + '" data-classification-audit="' + auditData + '" data-article-text="' + articleTextData + '">'
    + imageHtml
    + '<div class="card-body"><div class="publisher-row">'
    + '<img src="' + logo + '" alt="' + escapeHtml(hostname) + ' logo" class="logo" loading="lazy" />'
    + '<span class="publisher">' + escapeHtml(hostname) + '</span><span class="dot">•</span>'
    + '<span class="published">' + escapeHtml(formatPublishedAt(story.publishedAt)) + '</span>'
    + (isNonEnglish ? '<span class="lang-tag">' + escapeHtml(language) + '</span>' : '')
    + '</div><h2' + langAttr + '><a href="' + escapeHtml(story.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(story.title) + '</a></h2>'
    + '<p' + langAttr + '>' + escapeHtml(story.description || 'No abstract available.') + '</p>'
    + '<div class="feedback-row"><a class="read" href="' + escapeHtml(story.url) + '" target="_blank" rel="noopener noreferrer">Read on ' + escapeHtml(hostname) + '</a>'
    + accessible + mirrorHtml
    + '<div class="fb-row-actions">'
    + '<button class="fb-btn copy-cite-btn" data-cite-url="' + escapeHtml(story.url) + '" onclick="window._copyStoryCitation(this)">📋 Copy citation</button>'
    + '<button class="fb-btn" data-fb-url="' + escapeHtml(story.url) + '" data-fb-title="' + escapeHtml(story.title) + '" data-fb-reason="false-positive" onclick="window._fbClick(this)">🚫 False positive</button>'
    + '<select class="cluster-move-select" data-story-url="' + escapeHtml(story.url) + '" onchange="window._onMoveTargetPick(this)"><option value="">Move to…</option><option value="independent">Independent</option></select>'
    + '<button type="button" class="cluster-move-btn" data-story-url="' + escapeHtml(story.url) + '" onclick="window._confirmStoryMove(this)" disabled>Move</button>'
    + '</div></div></div></article>';
}

function renderDigestView(view) {
  CITATION_REPORT = view.citationReport || { groups: [], markdown: '' };
  rebuildCitationIndex();
  const root = document.getElementById('digest-root');
  if (!root) return;
  const groups = view.groups || [];
  const hasStories = (view.visibleStoryCount || 0) > 0;
  let html = '<header><h1>Cult News Digest</h1><p>'
    + (view.visibleStoryCount || 0) + ' visible stories (' + (view.corpusStoryCount || 0) + ' in corpus). View at ' + escapeHtml(view.generatedAt || '') + '.</p>'
    + '<div class="header-actions">'
    + '<button id="copy-all-citations-btn" onclick="window._copyAllCitations()" style="font-family:system-ui,sans-serif;font-size:0.8rem;font-weight:600;padding:5px 12px;border-radius:6px;border:1px solid #ded6c4;background:#f4f2ea;color:#5c5548;cursor:pointer;">📋 Copy all source citations</button>'
    + '<span id="copy-all-citations-status" class="status-note">✓ Citations copied — paste into your draft</span>'
    + '</div></header>';
  if (!hasStories) {
    html += '<div class="story-group"><div class="grid"><article class="empty-state"><h2>No stories in digest view</h2><p>Run npm run render:html to rebuild the corpus.</p></article></div></div>';
  } else {
    groups.forEach(function (group, groupIndex) {
      if (group.type === 'independent') {
        html += '<div class="story-group" data-citation-group-index="' + groupIndex + '" data-group-type="independent"><div class="group-header">'
          + '<p class="latest-heading" style="margin:0;border:0;padding:0;">Latest Stories</p>'
          + '<button class="copy-citations-btn" data-citation-group-index="' + groupIndex + '" onclick="window._copyGroupCitations(this)">Copy citations</button></div><div class="grid">'
          + group.stories.map(function (s) { return renderStoryCard(s); }).join('')
          + '</div></div>';
        return;
      }
      const clusterId = group.id || ('auto-' + groupIndex);
      html += '<div class="story-group" data-citation-group-index="' + groupIndex + '" data-cluster-id="' + escapeHtml(clusterId) + '" data-group-type="detected"><div class="group-header">'
        + '<h3 class="group-label">' + escapeHtml(group.label) + '</h3>'
        + '<input class="cluster-label-input" type="text" value="' + escapeHtml(group.label) + '" data-cluster-id="' + escapeHtml(clusterId) + '" placeholder="Cluster name" />'
        + '<span class="group-badge detected">Cluster</span>'
        + '<span class="group-count">' + group.stories.length + ' ' + (group.stories.length === 1 ? 'article' : 'articles') + '</span>'
        + '<button class="copy-citations-btn" data-citation-group-index="' + groupIndex + '" onclick="window._copyGroupCitations(this)">Copy citations</button>'
        + '<button class="fb-btn cluster-fp-btn" type="button" onclick="window._fbClickCluster(this)">🚫 False positive (all)</button>'
        + '<button class="cluster-delete-btn" type="button" data-cluster-id="' + escapeHtml(clusterId) + '" onclick="window._dissolveCluster(this)">Dissolve cluster</button>'
        + '</div><div class="grid">'
        + group.stories.map(function (s) { return renderStoryCard(s); }).join('')
        + '</div></div>';
    });
  }
  root.innerHTML = html;
}

async function refreshDigestView() {
  const res = await fetch(API_BASE + '/api/digest/view');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load digest view');
  renderDigestView(data);
  await _loadFeedback();
  await _loadClusterLayoutEditor();
}

function _copyTextToClipboard(text, onSuccess) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(function() {
    if (onSuccess) onSuccess();
  }).catch(function(err) {
    console.error('Clipboard copy failed:', err);
    alert('Could not copy to clipboard');
  });
}

window._copyStoryCitation = function(btn) {
  var url = btn.getAttribute('data-cite-url');
  var md = url ? CITATION_BY_URL[url] : '';
  _copyTextToClipboard(md, function() {
    btn.classList.add('copied');
    btn.textContent = '✓ Copied';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.textContent = '📋 Copy citation';
    }, 1800);
  });
};

window._copyGroupCitations = function(btn) {
  var idx = Number(btn.getAttribute('data-citation-group-index'));
  var group = CITATION_REPORT.groups[idx];
  if (!group) return;
  var heading = group.type === 'independent' ? '## Latest Stories' : ('## ' + group.label);
  var body = group.sources.map(function(source) { return source.markdown; }).join('\n');
  _copyTextToClipboard(heading + '\n\n' + body, function() {
    btn.classList.add('copied');
    btn.textContent = '✓ Copied';
    setTimeout(function() {
      btn.classList.remove('copied');
      btn.textContent = 'Copy citations';
    }, 1800);
  });
};

window._copyAllCitations = function() {
  _copyTextToClipboard(CITATION_REPORT.markdown, function() {
    var status = document.getElementById('copy-all-citations-status');
    if (status) {
      status.classList.add('show');
      setTimeout(function() { status.classList.remove('show'); }, 2500);
    }
  });
};

async function _fbLoad() { await refreshDigestView(); _checkReportStatus(); }

async function _checkReportStatus() {
  try {
    const res = await fetch(API_BASE + '/api/report/status');
    const data = await res.json();
    currentReport = data;
    _updateStatusUI(data);
    await _updateArticlePlanLink(data);
  } catch(e) {
    console.error('Failed to check report status:', e);
    document.getElementById('status-text').textContent = 'Error checking status';
  }
}

async function _updateArticlePlanLink(reportStatus) {
  var link = document.getElementById('article-plan-link');
  if (!link) return;
  if (reportStatus.status !== 'none') {
    link.style.display = 'none';
    return;
  }
  try {
    var res = await fetch(API_BASE + '/api/report/result');
    if (res.ok) {
      var report = await res.json();
      link.style.display = 'inline';
      link.textContent = 'Article planning (' + report.visibleStoryCount + ' stories) →';
    } else {
      link.style.display = 'none';
    }
  } catch (_) {
    link.style.display = 'none';
  }
}

function _updateStatusUI(data) {
  const statusText = document.getElementById('status-text');
  const initBtn = document.getElementById('init-report-btn');
  const resetBtn = document.getElementById('reset-report-btn');
  const closeBtn = document.getElementById('close-report-btn');
  const finalizeBtn = document.getElementById('finalize-report-btn');

  document.body.classList.remove('review-phase', 'verification-phase');

  if (data.status === 'none') {
    statusText.textContent = 'No active report';
    initBtn.style.display = 'inline';
    resetBtn.style.display = 'none';
    closeBtn.style.display = 'none';
    finalizeBtn.style.display = 'none';
  } else if (data.status === 'review') {
    statusText.textContent = 'Review phase (' + data.entryCount + ' flagged)';
    initBtn.style.display = 'none';
    resetBtn.style.display = 'inline';
    closeBtn.style.display = 'inline';
    finalizeBtn.style.display = 'none';
    document.body.classList.add('review-phase');
  } else if (data.status === 'verification') {
    statusText.textContent = 'Verification — pick a cluster, click Move, then Apply changes';
    initBtn.style.display = 'inline';
    resetBtn.style.display = 'inline';
    closeBtn.style.display = 'none';
    finalizeBtn.style.display = 'inline';
    document.body.classList.add('verification-phase');
  }
  _loadClusterLayoutEditor();
  _updateButtonVisibility();
}

var clusterLayoutState = null;

function _layoutFromDom() {
  var clusters = [];
  document.querySelectorAll('.story-group[data-group-type="detected"]').forEach(function(group, index) {
    var id = group.getAttribute('data-cluster-id') || ('auto-' + index);
    var labelInput = group.querySelector('.cluster-label-input');
    var labelEl = group.querySelector('.group-label');
    var label = (labelInput && labelInput.value.trim())
      ? labelInput.value.trim()
      : (labelEl ? labelEl.textContent.trim() : 'Cluster');
    var urls = [];
    group.querySelectorAll('.card[data-url]').forEach(function(card) {
      var url = card.getAttribute('data-url');
      if (url) urls.push(url);
    });
    clusters.push({ id: id, label: (label || 'Cluster').trim(), urls: urls });
  });
  var independentUrls = [];
  document.querySelectorAll('.story-group[data-group-type="independent"] .card[data-url]').forEach(function(card) {
    var url = card.getAttribute('data-url');
    if (url) independentUrls.push(url);
  });
  return { updatedAt: new Date().toISOString(), clusters: clusters, independentUrls: independentUrls };
}

function _findClusterForUrl(layout, url) {
  for (var i = 0; i < layout.clusters.length; i++) {
    if (layout.clusters[i].urls.indexOf(url) !== -1) return layout.clusters[i].id;
  }
  if (layout.independentUrls.indexOf(url) !== -1) return 'independent';
  return '';
}

function _removeUrlFromLayout(layout, url) {
  layout.clusters.forEach(function(cluster) {
    cluster.urls = cluster.urls.filter(function(u) { return u !== url; });
  });
  layout.independentUrls = layout.independentUrls.filter(function(u) { return u !== url; });
}

function _showToast(message) {
  var toast = document.getElementById('fb-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2200);
}

function _clusterGridForTarget(targetId) {
  if (targetId === 'independent') {
    var independent = document.querySelector('.story-group[data-group-type="independent"] .grid');
    return independent || null;
  }
  var group = document.querySelector('.story-group[data-group-type="detected"][data-cluster-id="' + targetId + '"]');
  return group ? group.querySelector('.grid') : null;
}

function _updateClusterCounts() {
  document.querySelectorAll('.story-group[data-group-type="detected"]').forEach(function(group) {
    var countEl = group.querySelector('.group-count');
    var cards = group.querySelectorAll('.grid .card[data-url]');
    if (countEl) {
      countEl.textContent = cards.length + ' ' + (cards.length === 1 ? 'article' : 'articles');
    }
  });
}

function _insertClusterSection(id, label) {
  if (document.querySelector('.story-group[data-cluster-id="' + id + '"]')) return;
  var section = document.createElement('div');
  section.className = 'story-group';
  section.setAttribute('data-group-type', 'detected');
  section.setAttribute('data-cluster-id', id);
  section.innerHTML =
    '<div class="group-header">' +
      '<h3 class="group-label">' + label + '</h3>' +
      '<input class="cluster-label-input" type="text" value="' + label.replace(/"/g, '&quot;') + '" data-cluster-id="' + id + '" placeholder="Cluster name">' +
      '<span class="group-badge detected">Cluster</span>' +
      '<span class="group-count">0 articles</span>' +
      '<button class="fb-btn cluster-fp-btn" type="button" onclick="window._fbClickCluster(this)">🚫 False positive (all)</button>' +
      '<button class="cluster-delete-btn" type="button" data-cluster-id="' + id + '" onclick="window._dissolveCluster(this)">Dissolve cluster</button>' +
    '</div>' +
    '<div class="grid"></div>';
  var independent = document.querySelector('.story-group[data-group-type="independent"]');
  if (independent && independent.parentNode) {
    independent.parentNode.insertBefore(section, independent);
  } else {
    var main = document.querySelector('main.wrap');
    if (main) main.appendChild(section);
  }
}

function _moveCardInDom(card, targetId) {
  var grid = _clusterGridForTarget(targetId);
  if (!grid || !card) return false;
  grid.appendChild(card);
  card.classList.remove('flagged-wc', 'flagged-fp');
  _updateClusterCounts();
  return true;
}

function _applyStoryMove(url, targetId) {
  if (!clusterLayoutState || !url || !targetId) return false;
  var current = _findClusterForUrl(clusterLayoutState, url);
  if (current === targetId) return false;
  _removeUrlFromLayout(clusterLayoutState, url);
  if (targetId === 'independent') {
    clusterLayoutState.independentUrls.push(url);
  } else {
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === targetId; });
    if (!cluster) return false;
    cluster.urls.push(url);
  }
  clusterLayoutState.updatedAt = new Date().toISOString();
  return true;
}

function _syncMoveButton(select) {
  var row = select.closest('.fb-row-actions');
  var btn = row ? row.querySelector('.cluster-move-btn') : null;
  if (!btn || !clusterLayoutState) {
    if (btn) btn.disabled = true;
    return;
  }
  var url = select.getAttribute('data-story-url');
  var current = _findClusterForUrl(clusterLayoutState, url);
  var target = select.value;
  btn.disabled = !target || target === current;
}

function _populateMoveSelects() {
  if (!clusterLayoutState) return;
  document.querySelectorAll('.cluster-move-select').forEach(function(select) {
    var url = select.getAttribute('data-story-url');
    if (!url) return;
    while (select.options.length > 1) select.remove(1);
    clusterLayoutState.clusters.forEach(function(cluster) {
      var opt = document.createElement('option');
      opt.value = cluster.id;
      opt.textContent = cluster.label;
      select.appendChild(opt);
    });
    select.value = '';
    _syncMoveButton(select);
  });
  document.querySelectorAll('.cluster-label-input').forEach(function(input) {
    var id = input.getAttribute('data-cluster-id');
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
    if (cluster && !input.matches(':focus')) input.value = cluster.label;
  });
}

window._onMoveTargetPick = function(select) {
  _syncMoveButton(select);
};

window._confirmStoryMove = function(btn) {
  if (!clusterLayoutState) return;
  var url = btn.getAttribute('data-story-url');
  var row = btn.closest('.fb-row-actions');
  var select = row ? row.querySelector('.cluster-move-select') : null;
  var target = select ? select.value : '';
  if (!url || !target) return;
  var current = _findClusterForUrl(clusterLayoutState, url);
  if (target === current) return;

  if (target !== 'independent') {
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === target; });
    if (cluster) _insertClusterSection(cluster.id, cluster.label);
  }

  if (!_applyStoryMove(url, target)) return;

  var card = btn.closest('.card');
  if (card && !_moveCardInDom(card, target)) {
    alert('Could not move card in the page. Click Apply changes & refresh to sync.');
  }

  if (select) {
    select.value = '';
    _syncMoveButton(select);
  }

  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'Unsaved moves — click Apply changes & refresh when done';
  var targetLabel = target === 'independent'
    ? 'Independent'
    : ((clusterLayoutState.clusters.find(function(c) { return c.id === target; }) || {}).label || 'cluster');
  _showToast('Moved to ' + targetLabel);
};

async function _loadClusterLayoutEditor() {
  try {
    var res = await fetch(API_BASE + '/api/cluster-layout');
    var data = await res.json();
    clusterLayoutState = (data.layout && Array.isArray(data.layout.clusters) && (data.layout.clusters.length > 0 || (data.layout.independentUrls && data.layout.independentUrls.length > 0))) ? data.layout : _layoutFromDom();
    _populateMoveSelects();
  } catch (e) {
    console.error('Failed to load cluster layout:', e);
    clusterLayoutState = _layoutFromDom();
    _populateMoveSelects();
  }
}

window._newCluster = function() {
  if (!clusterLayoutState) clusterLayoutState = _layoutFromDom();
  var label = prompt('Cluster name');
  if (!label || !label.trim()) return;
  var id = 'manual-' + Date.now();
  clusterLayoutState.clusters.push({ id: id, label: label.trim(), urls: [] });
  clusterLayoutState.updatedAt = new Date().toISOString();
  _insertClusterSection(id, label.trim());
  _populateMoveSelects();
  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'New cluster added — move stories with Move, then Apply changes';
  _showToast('Created cluster: ' + label.trim());
};

window._dissolveCluster = function(btn) {
  if (!clusterLayoutState) clusterLayoutState = _layoutFromDom();
  var id = btn.getAttribute('data-cluster-id');
  var groupEl = btn.closest('.story-group[data-group-type="detected"]');
  if (!id || !groupEl) return;

  var domUrls = [];
  groupEl.querySelectorAll('.card[data-url]').forEach(function(card) {
    var url = card.getAttribute('data-url');
    if (url) domUrls.push(url);
  });

  var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
  if (!cluster) {
    var labelInput = groupEl.querySelector('.cluster-label-input');
    var labelEl = groupEl.querySelector('.group-label');
    var label = (labelInput && labelInput.value.trim())
      ? labelInput.value.trim()
      : (labelEl ? labelEl.textContent.trim() : 'Cluster');
    cluster = { id: id, label: label, urls: domUrls.slice() };
    clusterLayoutState.clusters.push(cluster);
  } else {
    cluster.urls = domUrls.slice();
  }

  domUrls.forEach(function(url) {
    _removeUrlFromLayout(clusterLayoutState, url);
    if (clusterLayoutState.independentUrls.indexOf(url) === -1) {
      clusterLayoutState.independentUrls.push(url);
    }
  });
  clusterLayoutState.clusters = clusterLayoutState.clusters.filter(function(c) { return c.id !== id; });
  clusterLayoutState.updatedAt = new Date().toISOString();

  var independentGrid = _clusterGridForTarget('independent');
  if (!independentGrid) {
    alert('Could not find Independent section. Click Apply changes & refresh to sync.');
    return;
  }
  Array.prototype.slice.call(groupEl.querySelectorAll('.card[data-url]')).forEach(function(card) {
    _moveCardInDom(card, 'independent');
  });
  groupEl.remove();

  _populateMoveSelects();
  var status = document.getElementById('layout-status');
  if (status) status.textContent = 'Unsaved changes — click Apply changes & refresh';
  _showToast('Cluster dissolved — stories moved to Independent');
};

window._saveLayout = async function() {
  if (!clusterLayoutState) clusterLayoutState = _layoutFromDom();
  document.querySelectorAll('.cluster-label-input').forEach(function(input) {
    var id = input.getAttribute('data-cluster-id');
    var cluster = clusterLayoutState.clusters.find(function(c) { return c.id === id; });
    if (cluster) cluster.label = input.value.trim() || cluster.label;
  });
  var btn = document.getElementById('save-layout-btn');
  var status = document.getElementById('layout-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var res = await fetch(API_BASE + '/api/cluster-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: clusterLayoutState })
    });
    var data = await res.json();
    if (data.success) {
      await refreshDigestView(); _checkReportStatus();
    } else {
      throw new Error(data.error || 'Apply failed');
    }
  } catch (e) {
    console.error('Failed to save layout:', e);
    alert('Failed to save layout');
    if (btn) { btn.disabled = false; btn.textContent = 'Apply changes & refresh'; }
    if (status) status.textContent = 'Save failed';
  }
};

async function _loadFeedback() {
  try {
    const res = await fetch(API_BASE + '/api/feedback');
    const data = await res.json();
    data.entries.forEach(function(entry) {
      var card = document.querySelector('.card[data-url="' + entry.url + '"]');
      if (!card) return;
      card.classList.add(entry.reason === 'false-positive' ? 'flagged-fp' : 'flagged-wc');
      card.querySelectorAll('.fb-btn').forEach(function(btn) {
        if (btn.getAttribute('data-fb-reason') === entry.reason) {
          btn.classList.add('copied');
          btn.textContent = entry.reason === 'false-positive' ? '🚫 Flagged' : '⚠️ Flagged';
        }
      });
    });
  } catch(e) {
    console.error('Failed to load feedback:', e);
  }
}

function _updateButtonVisibility() {}

window._fbClickCluster = async function(btn) {
  if (!currentReport || currentReport.status !== 'review') {
    alert('False positive marking is only available during review phase (after Init Report)');
    return;
  }
  var group = btn.closest('.story-group[data-group-type="detected"]');
  if (!group) return;
  var labelInput = group.querySelector('.cluster-label-input');
  var labelEl = group.querySelector('.group-label');
  var label = (labelInput && labelInput.value.trim())
    ? labelInput.value.trim()
    : (labelEl ? labelEl.textContent.trim() : 'this cluster');
  var fpButtons = group.querySelectorAll('.fb-btn[data-fb-reason="false-positive"]');
  var pending = [];
  fpButtons.forEach(function(fpBtn) {
    var card = fpBtn.closest('.card');
    if (card && !card.classList.contains('flagged-fp')) pending.push(fpBtn);
  });
  if (pending.length === 0) {
    alert('Every story in this cluster is already flagged.');
    return;
  }
  if (!confirm('Mark all ' + pending.length + ' stories in "' + label + '" as false positives?')) return;
  btn.disabled = true;
  var marked = 0;
  try {
    for (var i = 0; i < pending.length; i++) {
      await window._fbClick(pending[i]);
      marked += 1;
    }
    _showToast('Flagged ' + marked + ' stories in cluster');
    _checkReportStatus();
  } catch(e) {
    console.error('Failed to flag cluster:', e);
    alert('Failed to flag entire cluster');
  } finally {
    btn.disabled = false;
  }
};

window._fbClick = async function(btn) {
  if (!currentReport || currentReport.status !== 'review') {
    alert('False positive marking is only available during review phase (after Init Report)');
    return;
  }
  var url = btn.getAttribute('data-fb-url');
  var title = btn.getAttribute('data-fb-title');
  var reason = btn.getAttribute('data-fb-reason') || 'false-positive';
  var card = btn.closest('.card');
  var auditJson = card ? card.getAttribute('data-classification-audit') : null;
  var classificationAudit = null;
  if (auditJson) {
    try { classificationAudit = JSON.parse(auditJson); } catch(e) {}
  }
  var articleText = card ? card.getAttribute('data-article-text') : null;

  // Check if already marked - if so, unmark instead
  var isMarked = card && (card.classList.contains('flagged-fp') || card.classList.contains('flagged-wc'));
  if (isMarked) {
    try {
      const res = await fetch(API_BASE + '/api/feedback/unmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      });
      const data = await res.json();
      if (data.success) {
        btn.classList.remove('copied');
        btn.textContent = reason === 'false-positive' ? '🚫 False positive' : '⚠️ Wrong cluster';
        if (card) {
          card.classList.remove('flagged-fp', 'flagged-wc');
        }
        _checkReportStatus();
      }
    } catch(e) {
      console.error('Failed to unmark:', e);
      alert('Failed to unmark');
    }
    return;
  }

  // Mark as false-positive
  try {
    const res = await fetch(API_BASE + '/api/feedback/false-positive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        title: title,
        articleText: articleText,
        classificationAudit: classificationAudit
      })
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.add('copied');
      btn.textContent = '🚫 Flagged';
      if (card) {
        card.classList.remove('flagged-fp', 'flagged-wc');
        card.classList.add('flagged-fp');
      }
      var toast = document.getElementById('fb-toast');
      toast.classList.add('show');
      setTimeout(function() { toast.classList.remove('show'); }, 2000);
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to save feedback:', e);
    alert('Failed to save feedback');
  }
};

document.getElementById('init-report-btn').addEventListener('click', async function() {
  try {
    const res = await fetch(API_BASE + '/api/report/init', { method: 'POST' });
    const data = await res.json();
    if (data.reportId) {
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to init report:', e);
    alert('Failed to initialize report');
  }
});

document.getElementById('reset-report-btn').addEventListener('click', async function() {
  if (!confirm('Reset this review session? In-progress flags will be cleared. Entries already saved via Close Report (false-positives.json) are not removed.')) return;
  const btn = this;
  btn.disabled = true;
  try {
    const res = await fetch(API_BASE + '/api/report/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      document.querySelectorAll('.card.flagged-fp, .card.flagged-wc').forEach(function(card) {
        card.classList.remove('flagged-fp', 'flagged-wc');
      });
      document.querySelectorAll('.fb-btn[data-fb-reason="false-positive"]').forEach(function(fpBtn) {
        fpBtn.classList.remove('copied');
        fpBtn.textContent = '🚫 False positive';
      });
      _checkReportStatus();
      _showToast('Review session reset');
    } else if (data.error) {
      alert(data.error);
    }
  } catch(e) {
    console.error('Failed to reset report:', e);
    alert('Failed to reset session');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('close-report-btn').addEventListener('click', async function() {
  if (!confirm('Close the false-positive review? Clusters will update without a full re-render.')) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const res = await fetch(API_BASE + '/api/report/close', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await refreshDigestView(); _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to close report:', e);
    alert('Failed to close report');
    btn.disabled = false;
    btn.textContent = 'Close Report';
  }
});

document.getElementById('finalize-report-btn').addEventListener('click', async function() {
  if (!confirm('Finalize report? This will archive feedback and export to training data.')) return;
  try {
    const res = await fetch(API_BASE + '/api/report/finalize', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('Report finalized: ' + data.archivedReportId + '\n\nNext: Article planning at /articles');
      _checkReportStatus();
    }
  } catch(e) {
    console.error('Failed to finalize report:', e);
    alert('Failed to finalize report');
  }
});

document.addEventListener('DOMContentLoaded', _fbLoad);
