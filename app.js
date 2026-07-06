/* ระบบแจ้งลางาน — frontend logic */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  token: localStorage.getItem('leave_token') || '',
  profile: null,
  types: [],
  holidays: new Set(),
  balances: [],
  dashboard: null,
  calMonth: null, // Date ต้นเดือนที่ปฏิทินแสดงอยู่
  workAllWeek: false, // true = นับวันลาทุกวัน ไม่ข้ามเสาร์-อาทิตย์/วันหยุด (ตั้งค่าที่ WORK_ALL_WEEK ใน Code.gs)
};

const STATUS_TH = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' };
const VIEW_TITLE = { home: 'ยื่นใบลา', history: 'ประวัติการลา', approve: 'รออนุมัติ', dashboard: 'สรุปภาพรวม (HR)' };

// ---------- เรียก API ----------

async function api(action, payload = {}, silent = false) {
  if (!silent) $('#loading').classList.remove('hidden');
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      // ไม่ใส่ Content-Type เพื่อให้เป็น simple request (Apps Script ไม่รองรับ CORS preflight)
      body: JSON.stringify(Object.assign({ action, token: state.token }, payload)),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    return data;
  } finally {
    if (!silent) $('#loading').classList.add('hidden');
  }
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ---------- เริ่มต้น ----------

async function boot() {
  if (typeof API_URL === 'undefined' || API_URL.indexOf('http') !== 0) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif">'
      + '⚠️ ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js<br>ดูขั้นตอนใน README.md</div>';
    return;
  }
  if (state.token) {
    try {
      applyBundle(await api('me'));
      showApp();
      return;
    } catch (e) {
      localStorage.removeItem('leave_token');
      state.token = '';
    }
  }
  $('#view-login').classList.remove('hidden');
}

function applyBundle(b) {
  state.token = b.token;
  state.profile = b.profile;
  state.types = b.types;
  state.holidays = new Set(b.holidays);
  state.balances = b.balances;
  state.workAllWeek = !!b.work_all_week;
  localStorage.setItem('leave_token', b.token);
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#topbar').classList.remove('hidden');
  $('#main').classList.remove('hidden');
  $('#bottomnav').classList.remove('hidden');
  $('#topbar-user').textContent = state.profile.name;

  const role = state.profile.role;
  if (role === 'approver' || role === 'admin') $('[data-view="approve"]').classList.remove('hidden');
  if (role === 'admin') $('[data-view="dashboard"]').classList.remove('hidden');

  renderBalances();
  renderTypeOptions();
  initFormDates();
  switchView('home');
}

// ---------- สลับหน้า ----------

function switchView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#topbar-title').textContent = VIEW_TITLE[name];
  if (name === 'history') loadHistory();
  if (name === 'approve') loadPending();
  if (name === 'dashboard') loadDashboard();
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

// ---------- login / logout ----------

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true;
  try {
    applyBundle(await api('login', {
      emp_id: $('#login-emp').value.trim(),
      pin: $('#login-pin').value,
      token: undefined,
    }));
    showApp();
    toast('สวัสดี ' + state.profile.name + ' 👋');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', () => {
  localStorage.removeItem('leave_token');
  location.reload();
});

// ---------- หน้าหลัก: วันลาคงเหลือ + ฟอร์ม ----------

function renderBalances() {
  $('#balance-cards').innerHTML = state.balances
    .filter((b) => b.quota !== null)
    .map((b) => `
      <div class="balance-card">
        <div class="b-name">${esc(b.name)}</div>
        <div class="b-num">${fmtNum(b.remaining)}</div>
        <div class="b-sub">เหลือจาก ${fmtNum(b.quota)} วัน${b.pending ? ` · รอ ${fmtNum(b.pending)}` : ''}</div>
      </div>`).join('');
}

function renderTypeOptions() {
  $('#f-type').innerHTML = state.types
    .map((t) => `<option value="${esc(t.type_id)}">${esc(t.name)}</option>`).join('');
}

function initFormDates() {
  const today = fmtDate(new Date());
  $('#f-start').value = today;
  $('#f-end').value = today;
  onDatesChange();
}

// นับวันทำการฝั่งหน้าเว็บ (ให้ผู้ใช้เห็นก่อนส่ง — ฝั่ง server นับซ้ำอีกรอบเสมอ)
function countBusinessDays(startStr, endStr, halfDay) {
  if (!startStr || !endStr || endStr < startStr) return 0;
  let count = 0;
  const d = parseDate(startStr);
  const end = parseDate(endStr);
  while (d <= end) {
    const dow = d.getDay();
    if (state.workAllWeek || (dow !== 0 && dow !== 6 && !state.holidays.has(fmtDate(d)))) count++;
    d.setDate(d.getDate() + 1);
  }
  if (halfDay && count === 1) count = 0.5;
  return count;
}

function onDatesChange() {
  const s = $('#f-start').value;
  const e = $('#f-end').value;
  const half = $('#f-half');
  half.disabled = !(s && s === e);
  if (half.disabled) half.checked = false;
  const days = countBusinessDays(s, e, half.checked);
  $('#f-days').textContent = days > 0
    ? (state.workAllWeek
      ? `รวม ${fmtNum(days)} วัน`
      : `รวม ${fmtNum(days)} วันทำการ (ไม่นับเสาร์-อาทิตย์และวันหยุดบริษัท)`)
    : 'ช่วงที่เลือกไม่มีวันทำการ';
}

['#f-start', '#f-end', '#f-half'].forEach((s) => $(s).addEventListener('change', onDatesChange));

$('#leave-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const days = countBusinessDays($('#f-start').value, $('#f-end').value, $('#f-half').checked);
  if (days <= 0) return toast('ช่วงที่เลือกไม่มีวันทำการ', true);

  let file = null;
  const f = $('#f-file').files[0];
  if (f) {
    if (f.size > 4 * 1024 * 1024) return toast('ไฟล์ใหญ่เกิน 4 MB', true);
    file = { name: f.name, mime: f.type, data: await toBase64(f) };
  }

  const btn = $('#f-submit');
  btn.disabled = true;
  try {
    const res = await api('submit', {
      type_id: $('#f-type').value,
      start: $('#f-start').value,
      end: $('#f-end').value,
      half_day: $('#f-half').checked,
      reason: $('#f-reason').value.trim(),
      file,
    });
    toast(`ส่งใบลาเรียบร้อย (${fmtNum(res.days)} วัน) รอหัวหน้าอนุมัติ ✓`);
    $('#f-reason').value = '';
    $('#f-file').value = '';
    initFormDates();
    applyBundle(await api('me', {}, true));
    renderBalances();
    switchView('history');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---------- ประวัติของฉัน ----------

async function loadHistory() {
  const box = $('#history-list');
  box.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const res = await api('myRequests', {}, true);
    if (!res.requests.length) {
      box.innerHTML = '<div class="empty">ยังไม่มีประวัติการลา</div>';
      return;
    }
    box.innerHTML = res.requests.map((r) => `
      <div class="req-card">
        <div class="req-top">
          <span class="req-title">${esc(typeName(r.type_id))} · ${fmtNum(r.days)} วัน</span>
          <span class="badge ${esc(r.status)}">${STATUS_TH[r.status] || esc(r.status)}</span>
        </div>
        <div class="req-meta">
          ${fmtThai(r.start_date)}${r.start_date !== r.end_date ? ' – ' + fmtThai(r.end_date) : ''}${r.half_day ? ' (ครึ่งวัน)' : ''}<br>
          เหตุผล: ${esc(r.reason || '-')}
          ${r.file_url ? `<br><a href="${esc(r.file_url)}" target="_blank" rel="noopener">📎 ไฟล์แนบ</a>` : ''}
          ${r.comment ? `<br>หมายเหตุผู้อนุมัติ: ${esc(r.comment)}` : ''}
        </div>
        ${r.status === 'pending' ? `
        <div class="req-actions">
          <button class="btn danger" onclick="cancelReq('${esc(r.req_id)}')">ยกเลิกใบลา</button>
        </div>` : ''}
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function cancelReq(reqId) {
  if (!confirm('ยืนยันยกเลิกใบลานี้?')) return;
  try {
    await api('cancel', { req_id: reqId });
    toast('ยกเลิกใบลาแล้ว');
    applyBundle(await api('me', {}, true));
    renderBalances();
    loadHistory();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- รออนุมัติ (หัวหน้า/แอดมิน) ----------

async function loadPending() {
  const box = $('#approve-list');
  box.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const res = await api('pending', {}, true);
    if (!res.requests.length) {
      box.innerHTML = '<div class="empty">ไม่มีใบลารออนุมัติ 🎉</div>';
      return;
    }
    box.innerHTML = res.requests.map((r) => `
      <div class="req-card">
        <div class="req-top">
          <span class="req-title">${esc(r.emp_name)}</span>
          <span class="badge pending">${esc(typeName(r.type_id))} ${fmtNum(r.days)} วัน</span>
        </div>
        <div class="req-meta">
          ${fmtThai(r.start_date)}${r.start_date !== r.end_date ? ' – ' + fmtThai(r.end_date) : ''}${r.half_day ? ' (ครึ่งวัน)' : ''}<br>
          เหตุผล: ${esc(r.reason || '-')}
          ${r.file_url ? `<br><a href="${esc(r.file_url)}" target="_blank" rel="noopener">📎 เปิดไฟล์แนบ</a>` : ''}
        </div>
        <div class="req-actions">
          <button class="btn primary" onclick="decide('${esc(r.req_id)}','approved')">✓ อนุมัติ</button>
          <button class="btn danger" onclick="decide('${esc(r.req_id)}','rejected')">✕ ไม่อนุมัติ</button>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function decide(reqId, decision) {
  let comment = '';
  if (decision === 'rejected') {
    comment = prompt('เหตุผลที่ไม่อนุมัติ (จะส่งอีเมลแจ้งพนักงาน):') || '';
  }
  try {
    await api('decide', { req_id: reqId, decision, comment });
    toast(decision === 'approved' ? 'อนุมัติเรียบร้อย ✓' : 'บันทึกไม่อนุมัติแล้ว');
    loadPending();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- dashboard (HR/admin) ----------

async function loadDashboard() {
  try {
    const res = await api('dashboard', {}, false);
    state.dashboard = res;
    if (!state.calMonth) {
      const now = new Date();
      state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    renderDashStats(res);
    renderUsage(res);
    renderCalendar();
    renderDashTable(res);
    renderManagerOptions(res);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderDashStats(res) {
  const onLeave = res.stats.onLeaveToday;
  $('#dash-stats').innerHTML = `
    <div class="stat-card"><div class="s-num">${res.stats.pending}</div><div class="s-label">รออนุมัติ</div></div>
    <div class="stat-card" title="${esc(onLeave.join(', '))}"><div class="s-num">${onLeave.length}</div><div class="s-label">ลาวันนี้${onLeave.length ? '<br>' + esc(onLeave.map(firstName).join(', ')) : ''}</div></div>
    <div class="stat-card"><div class="s-num">${fmtNum(res.stats.usedTotal)}</div><div class="s-label">วันลาที่ใช้ปีนี้ (รวม)</div></div>`;
}

function renderUsage(res) {
  const max = Math.max(1, ...res.typeUsage.map((t) => t.used));
  $('#dash-usage').innerHTML = res.typeUsage.map((t) => `
    <div class="usage-row">
      <div class="usage-label"><span>${esc(t.name)}</span><span>${fmtNum(t.used)} วัน</span></div>
      <div class="usage-bar"><div class="usage-fill" style="width:${(t.used / max) * 100}%"></div></div>
    </div>`).join('');
}

function renderCalendar() {
  const res = state.dashboard;
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  $('#cal-title').textContent = state.calMonth.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = fmtDate(new Date());

  let html = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell off"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = fmtDate(new Date(y, m, day));
    const dow = new Date(y, m, day).getDay();
    const isOff = !state.workAllWeek && (dow === 0 || dow === 6 || state.holidays.has(ds));
    const chips = isOff ? [] : res.leaves.filter((l) => l.start_date <= ds && ds <= l.end_date);
    const shown = chips.slice(0, 3);
    html += `<div class="cal-cell${isOff ? ' off' : ''}${ds === today ? ' today' : ''}">
      <span class="cal-daynum">${day}</span>
      ${shown.map((l) => `<span class="cal-chip${l.status === 'pending' ? ' pending' : ''}" title="${esc(l.emp_name)} · ${esc(typeName(l.type_id))}">${esc(firstName(l.emp_name))}</span>`).join('')}
      ${chips.length > 3 ? `<span class="cal-daynum">+${chips.length - 3}</span>` : ''}
    </div>`;
  }
  $('#calendar').innerHTML = `<div class="cal-grid">${html}</div>`;
}

$('#cal-prev').addEventListener('click', () => { state.calMonth.setMonth(state.calMonth.getMonth() - 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { state.calMonth.setMonth(state.calMonth.getMonth() + 1); renderCalendar(); });

function renderDashTable(res) {
  const quotaTypes = res.types.filter((t) => t.quota_days !== '' && t.quota_days !== null);
  const head = `<tr><th>พนักงาน</th><th>แผนก</th>${quotaTypes.map((t) => `<th class="num">${esc(t.name)}<br><small>เหลือ/สิทธิ์</small></th>`).join('')}</tr>`;
  const rows = res.employees.map((e) => {
    const cells = quotaTypes.map((t) => {
      const b = e.balances.find((x) => x.type_id === t.type_id) || {};
      const remaining = b.remaining == null ? '-' : fmtNum(b.remaining);
      const cls = b.remaining !== null && b.remaining <= 1 ? ' class="low"' : '';
      return `<td class="num"><span${cls}>${remaining}</span> / ${fmtNum(b.quota)}</td>`;
    }).join('');
    return `<tr><td>${esc(e.name)}</td><td>${esc(e.dept || '-')}</td>${cells}</tr>`;
  }).join('');
  $('#dash-table').innerHTML = head + rows;
}

// ---------- เพิ่มพนักงาน (HR/admin) ----------

function renderManagerOptions(res) {
  const sel = $('#e-manager');
  const current = sel.value;
  sel.innerHTML = '<option value="">— ไม่ระบุ (admin อนุมัติแทน) —</option>'
    + res.employees.map((e) => `<option value="${esc(e.emp_id)}">${esc(e.name)} (${esc(e.emp_id)})</option>`).join('');
  sel.value = current;
}

$('#emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#e-submit');
  btn.disabled = true;
  try {
    const res = await api('addEmployee', {
      emp_id: $('#e-id').value.trim(),
      name: $('#e-name').value.trim(),
      dept: $('#e-dept').value.trim(),
      email: $('#e-email').value.trim(),
      pin: $('#e-pin').value,
      role: $('#e-role').value,
      manager_id: $('#e-manager').value,
    });
    toast(`เพิ่มพนักงาน ${res.emp_id} เรียบร้อย ✓`);
    $('#emp-form').reset();
    loadDashboard();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- ตัวช่วย ----------

function typeName(typeId) {
  const t = state.types.find((x) => x.type_id === typeId);
  return t ? t.name : typeId;
}
function firstName(full) { return String(full).trim().split(/\s+/)[0]; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) {
  const v = Number(n);
  if (isNaN(v)) return '-';
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseDate(s) {
  const p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
function fmtThai(s) {
  if (!s) return '-';
  return parseDate(String(s).slice(0, 10)).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
}

// PWA: ลงทะเบียน service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
