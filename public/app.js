'use strict';

const $ = (id) => document.getElementById(id);

let selectedTags = []; // the selected bill type(s)
let pickedFiles = []; // {file, url}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { showLogin(); throw new Error('Not logged in'); }
  return res;
}

// ---- Auth ----------------------------------------------------------------
function showLogin() {
  $('login').style.display = 'block';
  $('appView').style.display = 'none';
}
function showApp(role) {
  $('login').style.display = 'none';
  $('appView').style.display = 'block';
  $('roleSub').textContent = role === 'finance' ? 'Signed in as Finance' : 'Signed in';
  $('dashLink').style.display = role === 'finance' ? 'inline-block' : 'none';
}

async function init() {
  const me = await (await fetch('/api/me')).json();
  if (me.role) {
    showApp(me.role);
    $('bill_date').value = new Date().toISOString().slice(0, 10);
    loadTags();
  } else {
    showLogin();
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('pw').value }),
  });
  if (res.ok) {
    const { role } = await res.json();
    $('pw').value = '';
    showApp(role);
    $('bill_date').value = new Date().toISOString().slice(0, 10);
    loadTags();
  } else {
    $('loginErr').textContent = 'Wrong password, try again.';
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ---- Bill type (chip library) -------------------------------------------
let tagLibrary = []; // [{name, pinned, count}]

function isSelected(name) {
  return selectedTags.some((x) => x.toLowerCase() === name.toLowerCase());
}

function renderTagLibrary() {
  const box = $('tagLibrary');
  box.innerHTML = '';

  // Any selected tags not yet in the fetched library (just-added) show too.
  const names = [...tagLibrary.map((t) => t.name)];
  for (const s of selectedTags) {
    if (!names.some((n) => n.toLowerCase() === s.toLowerCase())) {
      names.push(s);
      tagLibrary.push({ name: s, pinned: false, count: 0 });
    }
  }

  if (!tagLibrary.length) {
    box.innerHTML = '<span class="muted" style="font-size:13px">No tags yet — add one above.</span>';
    return;
  }

  for (const t of tagLibrary) {
    const c = document.createElement('span');
    c.className = 'chip' + (isSelected(t.name) ? ' on' : '');

    const label = document.createElement('span');
    label.textContent = t.pinned ? `📌 ${t.name}` : t.name;
    label.onclick = () => toggleTag(t.name);
    c.appendChild(label);

    if (!t.pinned) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Remove tag from library';
      x.onclick = (e) => { e.stopPropagation(); deleteTag(t); };
      c.appendChild(x);
    }
    box.appendChild(c);
  }
}

function toggleTag(name) {
  if (isSelected(name)) selectedTags = selectedTags.filter((x) => x.toLowerCase() !== name.toLowerCase());
  else selectedTags.push(name);
  renderTagLibrary();
}

async function addTag(name) {
  const t = String(name).trim();
  if (!t) return;
  if (!isSelected(t)) selectedTags.push(t);
  if (!tagLibrary.some((x) => x.name.toLowerCase() === t.toLowerCase())) {
    try { await api('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: t }) }); } catch {}
  }
  await loadTags();
}

async function deleteTag(t) {
  const used = t.count ? `\n\nIt is currently used on ${t.count} bill${t.count > 1 ? 's' : ''}, and will be removed from ${t.count > 1 ? 'them' : 'it'}.` : '';
  if (!confirm(`Remove the tag "${t.name}" from the library?${used}`)) return;
  try {
    const res = await api('/api/tags/' + encodeURIComponent(t.name), { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    selectedTags = selectedTags.filter((x) => x.toLowerCase() !== t.name.toLowerCase());
    toast('Tag removed');
    await loadTags();
  } catch (err) {
    toast(err.message || 'Could not remove tag', true);
  }
}

$('addTagBtn').addEventListener('click', () => { addTag($('tagInput').value); $('tagInput').value = ''; });
$('tagInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addTag($('tagInput').value);
    $('tagInput').value = '';
  }
});

async function loadTags() {
  try {
    tagLibrary = await (await api('/api/tags')).json();
  } catch { tagLibrary = []; }
  renderTagLibrary();
}

// ---- File previews -------------------------------------------------------
$('files').addEventListener('change', (e) => {
  for (const f of e.target.files) {
    pickedFiles.push({ file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
  }
  e.target.value = '';
  renderThumbs();
});
function renderThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  pickedFiles.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = p.url ? `<img src="${p.url}">` : `<div class="pdf">PDF</div>`;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.onclick = () => { pickedFiles.splice(i, 1); renderThumbs(); };
    d.appendChild(rm);
    box.appendChild(d);
  });
}

// ---- Submit --------------------------------------------------------------
$('billForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedTags.length) { toast('Pick at least one bill type', true); return; }

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  const fd = new FormData();
  fd.append('amount', $('amount').value);
  fd.append('vendor', $('vendor').value.trim());
  fd.append('bill_date', $('bill_date').value);
  fd.append('status', $('status').value);
  fd.append('note', $('note').value.trim());
  fd.append('tags', JSON.stringify(selectedTags));
  for (const p of pickedFiles) fd.append('screenshots', p.file);

  try {
    const res = await api('/api/bills', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    toast('Bill saved ✓');
    // reset
    $('billForm').reset();
    $('bill_date').value = new Date().toISOString().slice(0, 10);
    selectedTags = [];
    pickedFiles = [];
    renderTagLibrary();
    renderThumbs();
    loadTags();
  } catch (err) {
    toast(err.message || 'Failed to save', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Bill';
  }
});

init();
