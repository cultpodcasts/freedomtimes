import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '../reports/cult-news-latest.html');
const headerPath = join(__dirname, 'feedback-ui-header.js');
const outPath = join(__dirname, 'feedback-ui.js');

const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!m) throw new Error('Could not extract script from cult-news-latest.html');

let script = m[1];
script = script.replace(/var FB_GENERATED_AT[\s\S]*?var currentReport = null;\s*/, '');
script = script.replace(/var CITATION_REPORT[\s\S]*?var currentReport = null;\s*/, '');
script = script.replace(/function _fbLoad\(\) \{[\s\S]*?\}/, 'async function _fbLoad() { await refreshDigestView(); _checkReportStatus(); }');
script = script.replace(/window\.location\.reload\(\);/g, 'await refreshDigestView(); _checkReportStatus();');
script = script.replace(/Re-clustering…/g, 'Updating…');
script = script.replace(
  /The page will reload with updated clusters/,
  'Clusters will update without a full re-render',
);
script = script.replace(
  "'<button class=\"cluster-delete-btn\" type=\"button\" data-cluster-id=\"' + id + '\" onclick=\"window._dissolveCluster(this)\">Dissolve cluster</button>' +",
  "'<button class=\"fb-btn cluster-fp-btn\" type=\"button\" onclick=\"window._fbClickCluster(this)\">🚫 False positive (all)</button>' +\n      '<button class=\"cluster-delete-btn\" type=\"button\" data-cluster-id=\"' + id + '\" onclick=\"window._dissolveCluster(this)\">Dissolve cluster</button>' +",
);
script = script.replace(
  'clusterLayoutState = data.layout && data.layout.clusters ? data.layout : _layoutFromDom();',
  'clusterLayoutState = (data.layout && Array.isArray(data.layout.clusters) && (data.layout.clusters.length > 0 || (data.layout.independentUrls && data.layout.independentUrls.length > 0))) ? data.layout : _layoutFromDom();',
);
script = script.replace(
  /document\.body\.classList\.add\('verification-phase'\);\s*_loadClusterLayoutEditor\(\);\s*\}\s*_updateButtonVisibility\(\);/,
  "document.body.classList.add('verification-phase');\n  }\n  _loadClusterLayoutEditor();\n  _updateButtonVisibility();",
);
script = script.replace(
  "fetch(API_BASE + '/api/report/apply-layout', {\n      method: 'POST',",
  "fetch(API_BASE + '/api/cluster-layout', {\n      method: 'PUT',",
);

const header = readFileSync(headerPath, 'utf8');
writeFileSync(outPath, header + script, 'utf8');
console.log('[build-feedback-ui] wrote', outPath);
