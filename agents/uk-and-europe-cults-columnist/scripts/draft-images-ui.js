const slugInput = document.getElementById('slug');
const unitsEl = document.getElementById('units');
const statusEl = document.getElementById('status');

const params = new URLSearchParams(location.search);
if (params.get('slug')) slugInput.value = params.get('slug');

let state = { slug: slugInput.value, units: [] };

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#900' : '#066';
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
      <label class="skip-row"><input type="checkbox" data-skip ${skip ? 'checked' : ''} /> Skip image for this section</label>
      <label class="skip-row"><input type="checkbox" data-beyond ${unit.beyondEurope ? 'checked' : ''} /> Place under <strong>Beyond Europe</strong> (not main UK/EU body)</label>
    `;
    const grid = el.querySelector('.candidates');
    for (const c of unit.candidates) {
      const card = document.createElement('label');
      card.className = 'candidate' + (c.url === selected && !skip ? ' selected' : '');
      card.innerHTML = `
        <input type="radio" name="u-${unit.unitId}" value="${escapeAttr(c.url)}" ${c.url === selected && !skip ? 'checked' : ''} style="display:none" />
        <img src="${escapeAttr(c.url)}" alt="" loading="lazy" />
        <div class="score">${escapeHtml(c.source)} · score ${c.score}</div>
        <div class="src">${escapeHtml(c.storyHost)}</div>
      `;
      card.addEventListener('click', () => {
        unit.selectedUrl = c.url;
        unit.skip = false;
        el.querySelector('[data-skip]').checked = false;
        render();
      });
      grid.appendChild(card);
    }
    if (unit.candidates.length === 0) {
      grid.innerHTML = '<p>No candidates — try Collect again or add manually in selections JSON.</p>';
    }
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

document.getElementById('collect').addEventListener('click', async () => {
  const slug = slugInput.value.trim();
  setStatus('Collecting…');
  const r = await fetch('/api/draft-images/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) {
    setStatus(await r.text(), true);
    return;
  }
  await load();
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
