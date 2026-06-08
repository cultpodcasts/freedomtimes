/* Article planning UI — post-finalize review report → article buckets */
var API_BASE = window.location.origin;
var planState = null;
var dirty = false;
var saving = false;

var ROUNDUP_WEEKLY_ID = 'roundup-weekly';
var SKIP_BUCKET_ID = 'bucket-skip';
var selectedMergeUnitIds = new Set();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message) {
  var el = document.getElementById('plan-toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(function () { el.classList.remove('show'); }, 2400);
}

function unitById(id) {
  return (planState.units || []).find(function (u) { return u.id === id; });
}

function articleById(id) {
  return (planState.articles || []).find(function (a) { return a.id === id; });
}

function assignmentForUnit(unitId) {
  return planState.assignments[unitId] || null;
}

function progress() {
  var total = planState.units.length;
  var assigned = Object.keys(planState.assignments).length;
  var standalone = planState.articles.filter(function (a) { return a.type === 'standalone' && a.unitIds.length; }).length;
  var roundupUnits = planState.articles
    .filter(function (a) { return a.type === 'roundup'; })
    .reduce(function (n, a) { return n + a.unitIds.length; }, 0);
  var skipped = (articleById(SKIP_BUCKET_ID) || { unitIds: [] }).unitIds.length;
  return {
    total: total,
    assigned: assigned,
    unassigned: total - assigned,
    standalone: standalone,
    roundupUnits: roundupUnits,
    skipped: skipped,
  };
}

function markDirty() {
  dirty = true;
  updateHeader();
}

function updateHeader() {
  var prog = progress();
  var statusEl = document.getElementById('plan-status');
  var saveBtn = document.getElementById('save-plan-btn');
  var finalizeBtn = document.getElementById('finalize-plan-btn');
  var progressEl = document.getElementById('plan-progress');

  if (planState.status === 'finalized' && !dirty) {
    statusEl.textContent = 'Finalized';
    statusEl.className = 'status-pill finalized';
  } else if (dirty) {
    statusEl.textContent = 'Unsaved';
    statusEl.className = 'status-pill dirty';
  } else {
    statusEl.textContent = 'Draft';
    statusEl.className = 'status-pill draft';
  }

  saveBtn.disabled = saving || planState.status === 'finalized' && !dirty;
  finalizeBtn.disabled = saving || prog.unassigned > 0 || (planState.status === 'finalized' && !dirty);

  progressEl.hidden = false;
  progressEl.innerHTML =
    '<span><strong>' + prog.assigned + '</strong> / ' + prog.total + ' assigned</span>' +
    '<span><strong>' + prog.standalone + '</strong> standalone</span>' +
    '<span><strong>' + prog.roundupUnits + '</strong> in roundups</span>' +
    '<span><strong>' + prog.skipped + '</strong> skipped</span>' +
    (prog.unassigned > 0 ? '<span style="color:var(--accent)"><strong>' + prog.unassigned + '</strong> need a decision</span>' : '');

  document.getElementById('plan-subtitle').textContent =
    planState.visibleStoryCount + ' stories from review report ' + planState.reviewReportId.replace(/T/g, ' ').slice(0, 19);
}

function renderUnitCard(unit, options) {
  options = options || {};
  var assignedId = assignmentForUnit(unit.id);
  var kindLabel = unit.kind === 'cluster'
    ? 'Cluster · ' + unit.storyCount + ' stories'
    : 'Independent story';
  var titlesHtml = '';
  if (unit.kind === 'cluster' && unit.titles.length > 1) {
    titlesHtml = '<ul class="unit-titles">' + unit.titles.slice(0, 4).map(function (t) {
      return '<li>' + escapeHtml(t) + '</li>';
    }).join('') + (unit.titles.length > 4 ? '<li>…+' + (unit.titles.length - 4) + ' more</li>' : '') + '</ul>';
  }
  var nouns = (unit.topProperNouns || []).slice(0, 5).join(' · ');
  var selectHtml = '';
  if (!options.compact && unit.kind === 'story' && !assignmentForUnit(unit.id)) {
    selectHtml =
      '<label class="unit-select-row">' +
      '<input type="checkbox" data-merge-select="' + escapeHtml(unit.id) + '"' +
      (selectedMergeUnitIds.has(unit.id) ? ' checked' : '') + ' />' +
      'Select to merge</label>';
  }
  var actionsHtml = '';
  if (!options.compact) {
    var standaloneArticle = planState.articles.find(function (a) {
      return a.type === 'standalone' && a.unitIds.indexOf(unit.id) >= 0;
    });
    actionsHtml =
      '<div class="unit-actions">' +
      '<button type="button" data-action="standalone" data-unit="' + escapeHtml(unit.id) + '"' +
      (standaloneArticle ? ' class="active-standalone"' : '') + '>Own article</button>' +
      '<button type="button" data-action="roundup" data-unit="' + escapeHtml(unit.id) + '"' +
      (assignedId === ROUNDUP_WEEKLY_ID ? ' class="active-roundup"' : '') + '>Weekly roundup</button>' +
      '<button type="button" data-action="skip" data-unit="' + escapeHtml(unit.id) + '"' +
      (assignedId === SKIP_BUCKET_ID ? ' class="active-skip"' : '') + '>Skip</button>' +
      '</div>';
  }
  return '<article class="unit-card ' + unit.kind + '" data-unit-id="' + escapeHtml(unit.id) + '">' +
    selectHtml +
    '<div class="unit-kind">' + escapeHtml(kindLabel) + '</div>' +
    '<h3 class="unit-title">' + escapeHtml(unit.label) + '</h3>' +
    '<div class="unit-meta">' + escapeHtml((unit.hosts || []).join(', ')) + '</div>' +
    titlesHtml +
    (nouns ? '<div class="unit-nouns">' + escapeHtml(nouns) + '</div>' : '') +
    actionsHtml +
    '</article>';
}

function renderBucketUnitRow(unitId) {
  var unit = unitById(unitId);
  if (!unit) return '';
  return '<div class="bucket-unit" data-unit-id="' + escapeHtml(unitId) + '">' +
    '<div><strong>' + escapeHtml(unit.label) + '</strong>' +
    '<span>' + unit.storyCount + ' stor' + (unit.storyCount === 1 ? 'y' : 'ies') + '</span></div>' +
    '<button type="button" data-action="unassign" data-unit="' + escapeHtml(unitId) + '">Remove</button>' +
    '</div>';
}

function renderBucket(article) {
  if (article.type === 'standalone' && article.unitIds.length === 0) return '';
  var unitsHtml = article.unitIds.length
    ? article.unitIds.map(renderBucketUnitRow).join('')
    : '<p class="bucket-empty">No stories assigned yet</p>';

  var titleField = article.type === 'skip'
    ? '<span class="bucket-title-input">' + escapeHtml(article.title) + '</span>'
    : '<input class="bucket-title-input" type="text" value="' + escapeHtml(article.title) + '" data-article-id="' + escapeHtml(article.id) + '" />';

  var extraActions = '';
  if (article.type === 'roundup' && article.id !== ROUNDUP_WEEKLY_ID) {
    extraActions = '<button type="button" class="btn subtle" data-action="delete-roundup" data-article="' + escapeHtml(article.id) + '" style="font-size:0.72rem;padding:4px 8px">Delete</button>';
  }

  return '<div class="bucket-card ' + article.type + '" data-article-id="' + escapeHtml(article.id) + '">' +
    '<div class="bucket-head">' +
    '<span class="bucket-type ' + article.type + '">' + escapeHtml(article.type) + '</span>' +
    titleField +
    '<span class="bucket-count">' + article.unitIds.length + ' unit' + (article.unitIds.length === 1 ? '' : 's') + '</span>' +
    extraActions +
    '</div>' +
    '<div class="bucket-units">' + unitsHtml + '</div>' +
    (article.type === 'roundup' ? renderRoundupAssigner(article) : '') +
    '</div>';
}

function renderRoundupAssigner(article) {
  var unassigned = planState.units.filter(function (u) { return !assignmentForUnit(u.id); });
  if (unassigned.length === 0) {
    return '<div class="bucket-actions" style="margin-top:10px"><span style="font-size:0.75rem;color:var(--muted)">Assign via buttons on cards above</span></div>';
  }
  return '<div class="bucket-actions" style="margin-top:10px">' +
    '<select data-roundup-select="' + escapeHtml(article.id) + '" style="font-size:0.75rem;padding:4px 6px;border-radius:6px;border:1px solid var(--line)">' +
    '<option value="">Add unit…</option>' +
    unassigned.map(function (u) {
      return '<option value="' + escapeHtml(u.id) + '">' + escapeHtml(u.label.slice(0, 60)) + '</option>';
    }).join('') +
    '</select>' +
    '<button type="button" data-action="roundup-add" data-article="' + escapeHtml(article.id) + '" style="font-size:0.72rem;padding:4px 10px">Add</button>' +
    '</div>';
}

function render() {
  var unassigned = planState.units.filter(function (u) { return !assignmentForUnit(u.id); });
  var unassignedEl = document.getElementById('unassigned-units');
  var emptyEl = document.getElementById('unassigned-empty');

  unassignedEl.innerHTML = unassigned.map(function (u) { return renderUnitCard(u); }).join('');
  emptyEl.hidden = unassigned.length > 0;

  var buckets = planState.articles
    .filter(function (a) {
      if (a.type === 'skip') return true;
      if (a.type === 'roundup') return true;
      if (a.type === 'standalone') return a.unitIds.length > 0;
      return false;
    })
    .sort(function (a, b) {
      var order = { roundup: 0, standalone: 1, skip: 2 };
      return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.title.localeCompare(b.title);
    });

  document.getElementById('article-buckets').innerHTML = buckets.map(renderBucket).join('');
  updateMergeButton();
  updateHeader();
}

function updateMergeButton() {
  var btn = document.getElementById('merge-units-btn');
  if (!btn) return;
  btn.disabled = selectedMergeUnitIds.size < 2;
  btn.textContent = selectedMergeUnitIds.size >= 2
    ? 'Merge ' + selectedMergeUnitIds.size + ' selected into cluster…'
    : 'Merge selected into cluster…';
}

async function mergeSelectedUnits() {
  if (selectedMergeUnitIds.size < 2) return;
  var label = window.prompt('Cluster label:', 'New cluster');
  if (label === null || !label.trim()) return;
  try {
    var res = await fetch(API_BASE + '/api/article-plan/merge-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unitIds: Array.from(selectedMergeUnitIds),
        label: label.trim(),
      }),
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Merge failed');
    }
    planState = await res.json();
    selectedMergeUnitIds.clear();
    dirty = false;
    toast('Merged into cluster: ' + label.trim());
    render();
  } catch (e) {
    toast(e.message || 'Merge failed');
  }
}

function assignUnitLocal(unitId, articleId) {
  var unit = unitById(unitId);
  if (!unit) return;

  delete planState.assignments[unitId];
  planState.articles.forEach(function (a) {
    a.unitIds = a.unitIds.filter(function (id) { return id !== unitId; });
  });

  if (articleId === 'standalone') {
    var standaloneId = 'standalone-' + unitId;
    var existing = articleById(standaloneId);
    if (!existing) {
      existing = {
        id: standaloneId,
        type: 'standalone',
        title: unit.label,
        unitIds: [],
      };
      planState.articles.push(existing);
    }
    existing.unitIds = [unitId];
    planState.assignments[unitId] = standaloneId;
  } else {
    var target = articleById(articleId);
    if (!target) return;
    planState.assignments[unitId] = articleId;
    if (target.unitIds.indexOf(unitId) < 0) {
      target.unitIds.push(unitId);
    }
    planState.articles = planState.articles.filter(function (a) {
      return a.type !== 'standalone' || a.unitIds.length > 0;
    });
  }

  markDirty();
  render();
}

function unassignUnitLocal(unitId) {
  var articleId = planState.assignments[unitId];
  delete planState.assignments[unitId];
  if (articleId) {
    var article = articleById(articleId);
    if (article) {
      article.unitIds = article.unitIds.filter(function (id) { return id !== unitId; });
    }
  }
  planState.articles = planState.articles.filter(function (a) {
    return a.type !== 'standalone' || a.unitIds.length > 0;
  });
  markDirty();
  render();
}

async function loadPlan() {
  var res = await fetch(API_BASE + '/api/article-plan');
  if (!res.ok) {
    var err = await res.json().catch(function () { return {}; });
    throw new Error(err.error || 'Failed to load article plan');
  }
  planState = await res.json();
  dirty = false;
  render();
}

async function savePlan() {
  if (saving) return;
  saving = true;
  updateHeader();
  try {
    var res = await fetch(API_BASE + '/api/article-plan', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        articles: planState.articles,
        assignments: planState.assignments,
      }),
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Save failed');
    }
    planState = await res.json();
    dirty = false;
    toast('Plan saved');
    render();
  } catch (e) {
    toast(e.message || 'Save failed');
  } finally {
    saving = false;
    updateHeader();
  }
}

async function finalizePlan() {
  var prog = progress();
  if (prog.unassigned > 0) {
    toast('Assign all ' + prog.unassigned + ' remaining units first');
    return;
  }
  if (!window.confirm('Finalize article plan? This locks assignments and writes reports/article-plan.json for drafting.')) {
    return;
  }
  if (dirty) {
    await savePlan();
  }
  saving = true;
  updateHeader();
  try {
    var res = await fetch(API_BASE + '/api/article-plan/finalize', { method: 'POST' });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Finalize failed');
    }
    var data = await res.json();
    planState.status = 'finalized';
    dirty = false;
    toast('Finalized ' + data.articleCount + ' article(s) for writing');
    render();
  } catch (e) {
    toast(e.message || 'Finalize failed');
  } finally {
    saving = false;
    updateHeader();
  }
}

function addRoundupArticle() {
  var title = window.prompt('Roundup article title:', 'Roundup article');
  if (title === null) return;
  var id = 'roundup-' + Date.now();
  planState.articles.push({
    id: id,
    type: 'roundup',
    title: title.trim() || 'Roundup article',
    unitIds: [],
  });
  markDirty();
  render();
}

function deleteRoundupArticle(articleId) {
  var article = articleById(articleId);
  if (!article || article.type !== 'roundup' || article.id === ROUNDUP_WEEKLY_ID) return;
  article.unitIds.forEach(function (unitId) {
    delete planState.assignments[unitId];
  });
  planState.articles = planState.articles.filter(function (a) { return a.id !== articleId; });
  markDirty();
  render();
}

document.getElementById('unassigned-units').addEventListener('change', function (e) {
  var checkbox = e.target.closest('input[data-merge-select]');
  if (!checkbox) return;
  var unitId = checkbox.getAttribute('data-merge-select');
  if (checkbox.checked) {
    selectedMergeUnitIds.add(unitId);
  } else {
    selectedMergeUnitIds.delete(unitId);
  }
  updateMergeButton();
});

document.getElementById('unassigned-units').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-action]');
  if (!btn) return;
  var action = btn.getAttribute('data-action');
  var unitId = btn.getAttribute('data-unit');
  if (action === 'standalone') assignUnitLocal(unitId, 'standalone');
  if (action === 'roundup') assignUnitLocal(unitId, ROUNDUP_WEEKLY_ID);
  if (action === 'skip') assignUnitLocal(unitId, SKIP_BUCKET_ID);
});

document.getElementById('article-buckets').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.getAttribute('data-action') === 'unassign') {
    unassignUnitLocal(btn.getAttribute('data-unit'));
  }
  if (btn.getAttribute('data-action') === 'delete-roundup') {
    if (window.confirm('Delete this roundup bucket? Assigned stories will return to unassigned.')) {
      deleteRoundupArticle(btn.getAttribute('data-article'));
    }
  }
  if (btn.getAttribute('data-action') === 'roundup-add') {
    var articleId = btn.getAttribute('data-article');
    var select = document.querySelector('select[data-roundup-select="' + articleId + '"]');
    if (select && select.value) {
      assignUnitLocal(select.value, articleId);
    }
  }
});

document.getElementById('article-buckets').addEventListener('input', function (e) {
  var input = e.target.closest('.bucket-title-input[data-article-id]');
  if (!input) return;
  var article = articleById(input.getAttribute('data-article-id'));
  if (article) {
    article.title = input.value;
    markDirty();
  }
});

document.getElementById('save-plan-btn').addEventListener('click', savePlan);
document.getElementById('finalize-plan-btn').addEventListener('click', finalizePlan);
document.getElementById('add-roundup-btn').addEventListener('click', addRoundupArticle);
document.getElementById('merge-units-btn').addEventListener('click', mergeSelectedUnits);

loadPlan().catch(function (e) {
  document.getElementById('plan-subtitle').textContent = e.message;
  toast(e.message);
});
