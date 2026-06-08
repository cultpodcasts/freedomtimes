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

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#900' : '#066';
}

function appendLog(msg) {
  progressLog.textContent += msg + '\n';
  progressLog.scrollTop = progressLog.scrollHeight;
}

function runProgressStream(streamUrl, onDone) {
  if (activeStream) activeStream.close();
  progressPanel.hidden = false;
  progressBar.value = 0;
  progressLog.textContent = '';
  setStatus('Working…');

  const es = new EventSource(streamUrl);
  activeStream = es;

  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.percent != null) progressBar.value = data.percent;
    if (data.message) appendLog(data.message);
    if (data.level === 'error') {
      setStatus(data.message, true);
      es.close();
      activeStream = null;
      return;
    }
    if (data.level === 'done') {
      setStatus(data.message);
      es.close();
      activeStream = null;
      onDone?.();
    }
  };

  es.onerror = () => {
    es.close();
    activeStream = null;
    setStatus('Progress stream disconnected', true);
  };
}

function renderCandidateCard(c, unit, el, selected, skip) {
  const card = document.createElement('label');
  card.className = 'candidate' + (c.url === selected && !skip ? ' selected' : '');
  const q = c.quality;
  const tier = q?.tier ?? 'unknown';
  const rec = q?.recommendation ?? '';
  const warnTitle = q?.warnings?.length ? escapeAttr(q.warnings.join(' ')) : '';
  card.innerHTML = `
    <input type="radio" name="u-${unit.unitId}" value="${escapeAttr(c.url)}" ${c.url === selected && !skip ? 'checked' : ''} style="display:none" />
    <img src="${escapeAttr(c.url)}" alt="" loading="lazy" />
    <div class="score">${escapeHtml(c.source)} · score ${c.score}</div>
    <div class="quality tier-${escapeHtml(tier)}" title="${warnTitle}">${escapeHtml(q?.label ?? 'quality not probed')} · <span class="rec">${escapeHtml(rec)}</span></div>
    ${q?.warnings?.length ? `<div class="warn">${escapeHtml(q.warnings[0])}</div>` : ''}
    <div class="src">${escapeHtml(c.storyHost)}</div>
  `;
  card.addEventListener('click', () => {
    unit.selectedUrl = c.url;
    unit.skip = false;
    el.querySelector('[data-skip]').checked = false;
    render();
  });
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
    el.innerHTML = `
      <h2>${escapeHtml(unit.unitLabel)}</h2>
      <p class="meta">${escapeHtml(unit.unitId)}</p>
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

document.getElementById('probe').addEventListener('click', () => {
  const slug = slugInput.value.trim();
  if (!slug) return;
  runProgressStream(
    `/api/draft-images/probe-stream?slug=${encodeURIComponent(slug)}`,
    () => load(),
  );
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
