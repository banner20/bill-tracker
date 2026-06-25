'use strict';

const $ = (id) => document.getElementById(id);
let activeTag = '';
let currency = '₹';
let view = 'list';
let groupBy = 'tag';
let currentBills = [];

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2600);
}
function money(n) {
  if (n == null || n === '') return '—';
  return currency + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- CSV + clipboard -----------------------------------------------------
const CSV_HEADER = ['id', 'date', 'type', 'vendor', 'amount', 'status', 'due_date', 'tags', 'note'];
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function billsToCsv(bills) {
  const lines = [CSV_HEADER.join(',')];
  for (const b of bills) {
    lines.push([b.id, b.bill_date, b.bill_type, b.vendor, b.amount, b.status, b.due_date, (b.tags || []).join('; '), b.note].map(csvCell).join(','));
  }
  return lines.join('\n');
}
async function copyText(text) {
  // navigator.clipboard needs a secure context; over http://<LAN-ip> it is absent.
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
async function copyBills(bills, label) {
  const ok = await copyText(billsToCsv(bills));
  toast(ok ? `Copied ${bills.length} row${bills.length === 1 ? '' : 's'}${label ? ' · ' + label : ''}` : 'Copy failed — try Download CSV', !ok);
}
window.copyGroup = (i) => {
  const g = currentGroups[i];
  if (g) copyBills(g.bills, g.key);
};
let currentGroups = []; // [{key, bills}]

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401 || res.status === 403) { showLogin(); throw new Error('auth'); }
  return res;
}

// ---- Auth ----------------------------------------------------------------
function showLogin() { $('login').style.display = 'block'; $('dashView').style.display = 'none'; }
function showDash() { $('login').style.display = 'none'; $('dashView').style.display = 'block'; }

async function init() {
  const me = await (await fetch('/api/me')).json();
  currency = me.currency || '₹';
  if (me.role === 'finance') { showDash(); refresh(); loadTags(); }
  else showLogin();
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
    if (role !== 'finance') { $('loginErr').textContent = 'That password does not have dashboard access.'; return; }
    $('pw').value = '';
    showDash(); refresh(); loadTags();
  } else {
    $('loginErr').textContent = 'Wrong password, try again.';
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ---- Filters -------------------------------------------------------------
let debounce;
['q', 'fStatus', 'fFrom', 'fTo'].forEach((id) => {
  $(id).addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(refresh, 250); });
});
$('clearBtn').addEventListener('click', () => {
  ['q', 'fStatus', 'fFrom', 'fTo'].forEach((id) => ($(id).value = ''));
  activeTag = '';
  loadTags();
  refresh();
});
$('exportBtn').addEventListener('click', () => { window.location = '/api/export.csv'; });

async function loadTags() {
  const tags = await (await api('/api/tags')).json();
  const box = $('tagFilter');
  box.innerHTML = '';
  if (!tags.length) { box.innerHTML = '<span class="muted" style="font-size:13px">No tags yet</span>'; return; }
  for (const t of tags) {
    const c = document.createElement('span');
    c.className = 'chip' + (activeTag === t.name ? ' on' : '');
    c.textContent = `${t.name} (${t.count})`;
    c.onclick = () => { activeTag = activeTag === t.name ? '' : t.name; loadTags(); refresh(); };
    box.appendChild(c);
  }
}

// ---- View switching ------------------------------------------------------
document.querySelectorAll('#viewSeg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view;
    document.querySelectorAll('#viewSeg .seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
    $('groupBy').style.display = view === 'grouped' ? 'inline-block' : 'none';
    render();
  });
});
$('groupBy').addEventListener('change', () => { groupBy = $('groupBy').value; render(); });
$('copyAllBtn').addEventListener('click', () => copyBills(currentBills, 'filtered'));

// ---- Fetch + render ------------------------------------------------------
async function refresh() {
  const params = new URLSearchParams();
  if ($('q').value) params.set('q', $('q').value);
  if ($('fStatus').value) params.set('status', $('fStatus').value);
  if ($('fFrom').value) params.set('from', $('fFrom').value);
  if ($('fTo').value) params.set('to', $('fTo').value);
  if (activeTag) params.set('tag', activeTag);

  let data;
  try { data = await (await api('/api/bills?' + params)).json(); }
  catch { return; }

  currentBills = data.bills;
  $('summary').innerHTML = `
    <div><span class="k">Bills shown</span><span class="v">${data.count}</span></div>
    <div><span class="k">Total amount</span><span class="v">${money(data.total)}</span></div>
  `;
  render();
}

function render() {
  const list = $('list');
  if (!currentBills.length) {
    list.innerHTML = '<div class="empty">No bills match these filters.</div>';
    return;
  }
  if (view === 'list') list.innerHTML = currentBills.map(renderBill).join('');
  else if (view === 'table') renderTable(list);
  else renderGrouped(list);
}

function sum(bills) { return bills.reduce((s, b) => s + (b.amount || 0), 0); }

// ---- Table view ----------------------------------------------------------
function billTypeHtml(b) {
  const types = (b.tags && b.tags.length) ? b.tags : (b.bill_type ? [b.bill_type] : []);
  return types.map((t) => `<span class="tag-pill">${esc(t)}</span>`).join(' ');
}
function tableRows(bills) {
  return bills.map((b) => {
    const att = (b.attachments || []).length
      ? `<span class="mini-att" onclick="openFirst(${b.id})" title="View proof">📎 ${b.attachments.length}</span>` : '';
    return `<tr>
      <td>${esc(b.bill_date || '')}</td>
      <td>${billTypeHtml(b)}</td>
      <td>${esc(b.vendor || '')}</td>
      <td class="amount">${money(b.amount)}</td>
      <td><span class="status ${b.status}">${b.status}</span></td>
      <td>${att}</td>
    </tr>`;
  }).join('');
}
function renderTable(list) {
  list.innerHTML = `<div class="table-wrap"><table class="bills">
    <thead><tr><th>Date</th><th>Bill type</th><th>Vendor</th><th>Amount</th><th>Status</th><th>Proof</th></tr></thead>
    <tbody>${tableRows(currentBills)}</tbody>
  </table></div>`;
}

// ---- Grouped view --------------------------------------------------------
function renderGrouped(list) {
  const groups = {};
  for (const b of currentBills) {
    let keys;
    if (groupBy === 'tag') keys = (b.tags && b.tags.length) ? b.tags : ['(untagged)'];
    else if (groupBy === 'month') keys = [(b.bill_date || '').slice(0, 7) || '(no date)'];
    else keys = [b[groupBy] || '(none)'];
    for (const k of keys) (groups[k] = groups[k] || []).push(b);
  }
  const keys = Object.keys(groups).sort((a, b) => groupBy === 'month' ? b.localeCompare(a) : a.localeCompare(b));
  currentGroups = keys.map((k) => ({ key: k, bills: groups[k] }));

  list.innerHTML = currentGroups.map((g, i) => `
    <div class="group">
      <div class="group-head">
        <div><span class="g-title">${esc(g.key)}</span><span class="g-sub">${g.bills.length} bill${g.bills.length === 1 ? '' : 's'} · ${money(sum(g.bills))}</span></div>
        <button class="btn sm ghost" onclick="copyGroup(${i})">Copy CSV</button>
      </div>
      <div class="group-body"><table class="bills">
        <tbody>${tableRows(g.bills)}</tbody>
      </table></div>
    </div>`).join('');
}

window.openFirst = (id) => {
  const b = currentBills.find((x) => x.id === id);
  const a = b && b.attachments && b.attachments[0];
  if (!a) return;
  if ((a.mime || '').startsWith('image/')) openImg('/uploads/' + a.filename);
  else window.open('/uploads/' + a.filename, '_blank');
};

function renderBill(b) {
  const atts = (b.attachments || []).map((a) => {
    if ((a.mime || '').startsWith('image/')) {
      return `<a href="#" onclick="openImg('/uploads/${a.filename}');return false"><img src="/uploads/${a.filename}" alt=""></a>`;
    }
    return `<a href="/uploads/${a.filename}" target="_blank"><span class="pdf">PDF</span></a>`;
  }).join('');

  return `
    <div class="bill">
      <div class="head">
        <div>
          <div class="type">${billTypeHtml(b) || esc(b.bill_type)}</div>
          <div class="meta">${esc(b.bill_date || '')}${b.vendor ? ' · ' + esc(b.vendor) : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="amount">${money(b.amount)}</div>
          <span class="status ${b.status}">${b.status}</span>
        </div>
      </div>
      ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}
      ${atts ? `<div class="attach-row">${atts}</div>` : ''}
      <div class="attach-row" style="margin-top:12px;gap:8px">
        ${statusBtn(b, 'paid', 'Mark paid')}
        ${statusBtn(b, 'reviewed', 'Mark reviewed')}
        ${statusBtn(b, 'unpaid', 'Mark unpaid')}
        <button class="btn sm danger" onclick="del(${b.id})">Delete</button>
      </div>
    </div>`;
}

function statusBtn(b, status, label) {
  if (b.status === status) return '';
  return `<button class="btn sm ghost" onclick="setStatus(${b.id}, '${status}')">${label}</button>`;
}

window.setStatus = async (id, status) => {
  try {
    const res = await api('/api/bills/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error();
    toast('Updated ✓');
    refresh();
  } catch { toast('Update failed', true); }
};

window.del = async (id) => {
  if (!confirm('Delete this bill and its attachments?')) return;
  try {
    const res = await api('/api/bills/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    toast('Deleted');
    refresh(); loadTags();
  } catch { toast('Delete failed', true); }
};

window.openImg = (src) => {
  $('lightboxImg').src = src;
  $('lightbox').classList.add('show');
};
$('lightbox').addEventListener('click', () => $('lightbox').classList.remove('show'));

init();
