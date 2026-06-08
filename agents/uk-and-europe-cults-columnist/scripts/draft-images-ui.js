const slugInput = document.getElementById('slug');
const unitsEl = document.getElementById('units');
const statusEl = document.getElementById('status');
const progressPanel = document.getElementById('progress-panel');
const progressBar = document.getElementById('progress-bar');
const progressLog = document.getElementById('progress-log');

const params = new URLSearchParams(location.search);
if (params.get('slug')) slugInput.value = params.get('slug');

let state = { slug: slugInput.value, units: [] };
let activeStream = null;
let lightboxState = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#900' : '#066';
}

function appendLog(msg) {
  progressLog.textContent += msg + '\n';
  progressLog.scrollTop = progressLog.scrollHeight;
}

function handleProgressEvent(data, onDone) {
  if (data.percent != null) progressBar.value = data.percent;
  if (data.message) appendLog(data.message);
  if (data.level === 'error') {
    setStatus(data.message, true);
    return true;
  }
  if (data.level === 'done') {
    setStatus(data.message);
    onDone?.();
    return true;
  }
  return false;
}

async function consumeProgressStream(streamUrl, onDone) {
  const res = await fetch(streamUrl, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 404) {
      throw new Error('Restart feedback server: npm run feedback:server');
    }
    throw new Error(errText || `Stream failed (${res.status})`);
  }
  if (!res.body) throw new Error('No response body from progress stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const data = JSON.parse(dataLine.slice(5).trim());
      if (handleProgressEvent(data, onDone)) return;
    }
  }
}

async function runPostProbe(slug, onDone) {
  appendLog('Probing via API (limited progress)…');
  const r = await fetch('/api/draft-images/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) {
    const msg = await r.text();
    if (r.status === 404) {
      throw new Error('Restart feedback server: npm run feedback:server');
    }
    throw new Error(msg || `Probe failed (${r.status})`);
  }
  const data = await r.json();
  progressBar.value = 100;
  appendLog(`Quality updated — ${data.unitCount} units`);
  setStatus('Quality probe complete');
  onDone?.();
}

async function runProgressStream(streamUrl, onDone, { fallback } = {}) {
  if (activeStream) activeStream.abort?.();
  progressPanel.hidden = false;
  progressBar.value = 0;
  progressLog.textContent = '';
  setStatus('Working…');

  const controller = new AbortController();
  activeStream = controller;

  try {
    await consumeProgressStream(streamUrl, onDone);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(message);
    if (fallback) {
      try {
        await fallback();
        return;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        setStatus(fbMsg, true);
        return;
      }
    }
    setStatus(message, true);
  } finally {
    activeStream = null;
  }
}

function decodeStoryUnitId(unitId) {
  if (unitId?.startsWith('story:')) {
    try {
      return decodeURIComponent(unitId.slice('story:'.length));
    } catch {
      return unitId.slice('story:'.length);
    }
  }
  return null;
}

function renderUnitSourceLinks(unit) {
  const stories = unit.stories ?? [];
  if (stories.length > 0) {
    return stories
      .map(
        (s) =>
          `<a class="unit-source" href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a>`,
      )
      .join('');
  }
  const decoded = decodeStoryUnitId(unit.unitId);
  if (decoded) {
    return `<a class="unit-source" href="${escapeAttr(decoded)}" target="_blank" rel="noopener noreferrer">${escapeHtml(decoded)}</a>`;
  }
  return `<span class="unit-id">${escapeHtml(unit.unitId)}</span>`;
}

function candidateMeta(c) {
  const q = c.quality;
  const rec = q?.recommendation ?? '';
  return `${c.source} · ${q?.label ?? 'quality not probed'}${rec ? ` · ${rec}` : ''} · ${c.storyHost}`;
}

function openLightbox(unit, startIndex, unitEl) {
  if (!unit.candidates.length) return;
  const index = Math.max(0, Math.min(startIndex, unit.candidates.length - 1));
  lightboxState = { unit, unitEl, index };
  document.getElementById('lightbox').hidden = false;
  document.getElementById('lightbox-title').textContent = unit.unitLabel;
  document.body.classList.add('lightbox-open');
  showLightboxSlide();
}

function showLightboxSlide() {
  if (!lightboxState) return;
  const { unit, index } = lightboxState;
  const c = unit.candidates[index];
  if (!c) return;

  const selected = unit.selectedUrl ?? unit.suggestedUrl ?? '';
  const img = document.getElementById('lightbox-img');
  img.src = c.url;
  img.alt = unit.unitLabel;
  document.getElementById('lightbox-meta').textContent = candidateMeta(c);
  const storyNote =
    (unit.stories?.length ?? 0) > 1
      ? `${unit.stories.length} stories · `
      : '1 story · ';
  document.getElementById('lightbox-counter').textContent =
    `${storyNote}image ${index + 1} / ${unit.candidates.length}`;

  const prev = document.getElementById('lightbox-prev');
  const next = document.getElementById('lightbox-next');
  prev.disabled = index <= 0;
  next.disabled = index >= unit.candidates.length - 1;

  const selectBtn = document.getElementById('lightbox-select');
  const isSelected = c.url === selected && !unit.skip;
  selectBtn.textContent = isSelected ? 'Selected' : 'Use this image';
  selectBtn.classList.toggle('is-selected', isSelected);
}

function lightboxStep(delta) {
  if (!lightboxState) return;
  const next = lightboxState.index + delta;
  if (next < 0 || next >= lightboxState.unit.candidates.length) return;
  lightboxState.index = next;
  showLightboxSlide();
}

function selectLightboxImage() {
  if (!lightboxState) return;
  const { unit, unitEl, index } = lightboxState;
  const c = unit.candidates[index];
  if (!c) return;
  unit.selectedUrl = c.url;
  unit.skip = false;
  if (unitEl) {
    const skipEl = unitEl.querySelector('[data-skip]');
    if (skipEl) skipEl.checked = false;
  }
  showLightboxSlide();
  render();
}

function closeLightbox() {
  document.getElementById('lightbox').hidden = true;
  document.getElementById('lightbox-img').removeAttribute('src');
  document.body.classList.remove('lightbox-open');
  lightboxState = null;
}

function renderCandidateCard(c, unit, el, selected, skip) {
  const card = document.createElement('div');
  card.className = 'candidate' + (c.url === selected && !skip ? ' selected' : '');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  const q = c.quality;
  const tier = q?.tier ?? 'unknown';
  const rec = q?.recommendation ?? '';
  const warnTitle = q?.warnings?.length ? escapeAttr(q.warnings.join(' ')) : '';
  const candidateIndex = unit.candidates.indexOf(c);
  card.innerHTML = `
    <div class="thumb-wrap">
      <img src="${escapeAttr(c.url)}" alt="" loading="lazy" />
      <button type="button" class="expand-btn" title="View full size" aria-label="View full size">⤢</button>
    </div>
    <div class="score">${escapeHtml(c.source)} · score ${c.score}</div>
    <div class="quality tier-${escapeHtml(tier)}" title="${warnTitle}">${escapeHtml(q?.label ?? 'quality not probed')} · <span class="rec">${escapeHtml(rec)}</span></div>
    ${q?.warnings?.length ? `<div class="warn">${escapeHtml(q.warnings[0])}</div>` : ''}
    <div class="src">${escapeHtml(c.storyHost)}</div>
  `;
  const select = () => {
    unit.selectedUrl = c.url;
    unit.skip = false;
    el.querySelector('[data-skip]').checked = false;
    render();
  };
  card.addEventListener('click', select);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  });
  const openCarousel = (e) => {
    e.stopPropagation();
    openLightbox(unit, candidateIndex, el);
  };
  card.querySelector('.expand-btn').addEventListener('click', openCarousel);
  card.querySelector('img').addEventListener('dblclick', openCarousel);
  return card;
}

async function addCustomImage(unitId, payload) {
  const slug = slugInput.value.trim();
  setStatus('Adding your image…');
  const r = await fetch('/api/draft-images/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, unitId, ...payload }),
  });
  if (!r.ok) {
    setStatus(await r.text(), true);
    return false;
  }
  const data = await r.json();
  const unit = state.units.find((u) => u.unitId === unitId);
  if (unit) {
    unit.selectedUrl = data.selectedUrl;
    unit.skip = false;
  }
  setStatus('Custom image added');
  await load();
  return true;
}

async function uploadPastedFile(unitId, file) {
  const reader = new FileReader();
  reader.onload = async () => {
    await addCustomImage(unitId, { imageBase64: reader.result });
  };
  reader.readAsDataURL(file);
}

function render() {
  unitsEl.innerHTML = '';
  for (const unit of state.units) {
    const el = document.createElement('section');
    el.className = 'unit';
    const selected = unit.selectedUrl ?? unit.suggestedUrl ?? '';
    const skip = Boolean(unit.skip);
    const storyCount = unit.stories?.length ?? 0;
    const kindLabel =
      storyCount > 1
        ? `Cluster · ${storyCount} stories`
        : 'Independent · 1 story';
    const candLabel = `${unit.candidates.length} image option${unit.candidates.length === 1 ? '' : 's'}`;
    el.innerHTML = `
      <h2>${escapeHtml(unit.unitLabel)}</h2>
      <p class="meta">${kindLabel} · ${candLabel}</p>
      <div class="unit-sources">${renderUnitSourceLinks(unit)}</div>
      <div class="candidates"></div>
      <div class="custom-add">
        <label class="custom-url-row">Your image URL
          <input type="url" data-custom-url placeholder="https://…" />
        </label>
        <button type="button" data-add-url>Add URL</button>
        <div class="paste-zone" data-paste tabindex="0">Paste image here (Ctrl+V) or drop a file</div>
      </div>
      <label class="skip-row"><input type="checkbox" data-skip ${skip ? 'checked' : ''} /> Skip image for this section</label>
      <label class="skip-row"><input type="checkbox" data-beyond ${unit.beyondEurope ? 'checked' : ''} /> Place under <strong>Beyond Europe</strong> (not main UK/EU body)</label>
    `;
    const grid = el.querySelector('.candidates');
    for (const c of unit.candidates) {
      grid.appendChild(renderCandidateCard(c, unit, el, selected, skip));
    }
    if (unit.candidates.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No candidates yet — Collect or add your own image below.';
      grid.appendChild(empty);
    }

    el.querySelector('[data-add-url]').addEventListener('click', async () => {
      const url = el.querySelector('[data-custom-url]').value.trim();
      if (!url) {
        setStatus('Enter an image URL first', true);
        return;
      }
      await addCustomImage(unit.unitId, { url });
    });

    const pasteZone = el.querySelector('[data-paste]');
    pasteZone.addEventListener('paste', (e) => {
      const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const file = item.getAsFile();
      if (file) uploadPastedFile(unit.unitId, file);
    });
    pasteZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      pasteZone.classList.add('drag-over');
    });
    pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('drag-over'));
    pasteZone.addEventListener('drop', (e) => {
      e.preventDefault();
      pasteZone.classList.remove('drag-over');
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
      if (file) uploadPastedFile(unit.unitId, file);
    });

    el.querySelector('[data-skip]').addEventListener('change', (e) => {
      unit.skip = e.target.checked;
      render();
    });
    el.querySelector('[data-beyond]').addEventListener('change', (e) => {
      unit.beyondEurope = e.target.checked;
    });
    unitsEl.appendChild(el);
  }
}

async function load() {
  const slug = slugInput.value.trim();
  if (!slug) return;
  setStatus('Loading…');
  const r = await fetch(`/api/draft-images?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) {
    setStatus(await r.text(), true);
    return;
  }
  state = await r.json();
  render();
  setStatus(`Loaded ${state.units.length} units`);
}

document.getElementById('collect').addEventListener('click', () => {
  const slug = slugInput.value.trim();
  if (!slug) return;
  runProgressStream(
    `/api/draft-images/collect-stream?slug=${encodeURIComponent(slug)}`,
    () => load(),
  );
});

document.getElementById('probe').addEventListener('click', async () => {
  const slug = slugInput.value.trim();
  if (!slug) return;
  const check = await fetch(`/api/draft-images?slug=${encodeURIComponent(slug)}`);
  if (!check.ok) {
    setStatus('No candidates file yet — run Collect candidates first', true);
    return;
  }
  await runProgressStream(
    `/api/draft-images/probe-stream?slug=${encodeURIComponent(slug)}`,
    () => load(),
    { fallback: () => runPostProbe(slug, () => load()) },
  );
});

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxStep(-1);
});
document.getElementById('lightbox-next').addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxStep(1);
});
document.getElementById('lightbox-select').addEventListener('click', (e) => {
  e.stopPropagation();
  selectLightboxImage();
});
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (!lightboxState) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
  else if (e.key === 'ArrowRight') lightboxStep(1);
  else if (e.key === 'Enter') selectLightboxImage();
});

document.getElementById('save').addEventListener('click', async () => {
  const slug = slugInput.value.trim();
  setStatus('Saving…');
  const selections = {
    slug,
    savedAt: new Date().toISOString(),
    units: state.units.map((u) => ({
      unitId: u.unitId,
      selectedUrl: u.skip ? null : (u.selectedUrl ?? u.suggestedUrl ?? null),
      alt: u.alt ?? u.suggestedAlt ?? u.unitLabel,
      skip: Boolean(u.skip),
      beyondEurope: Boolean(u.beyondEurope),
    })),
  };
  const r = await fetch('/api/draft-images', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(selections),
  });
  if (!r.ok) {
    setStatus(await r.text(), true);
    return;
  }
  setStatus('Selections saved');
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

load();
