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
