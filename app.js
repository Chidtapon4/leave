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
  staff: null,       // ข้อมูลจาก action 'employees' (รายชื่อ + สิทธิ์รายคน)
  editingEmp: null,  // emp_id ที่กำลังแก้ไขในฟอร์มพนักงาน (null = โหมดเพิ่มใหม่)
  myRequests: [],    // ประวัติใบลาของฉัน (ใช้ตอนกดแก้ไขใบลา)
  editingReq: null,  // req_id ที่กำลังแก้ไขในฟอร์มยื่นลา (null = ยื่นใหม่)
  calMonth: null, // Date ต้นเดือนที่ปฏิทินแสดงอยู่
  workAllWeek: false, // true = นับวันลาทุกวัน ไม่ข้ามเสาร์-อาทิตย์/วันหยุด (ตั้งค่าที่ WORK_ALL_WEEK ใน Code.gs)
};

const STATUS_TH = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' };
const ROLE_TH = { employee: 'พนักงาน', approver: 'หัวหน้า', admin: 'HR/แอดมิน' };
const VIEW_TITLE = { home: 'ยื่นใบลา', history: 'ประวัติการลา', mydash: 'สรุปของฉัน', approve: 'รออนุมัติ', dashboard: 'สรุปภาพรวม (HR)', staff: 'จัดการพนักงาน', profile: 'ข้อมูลของฉัน' };

// สีประจำประเภทลา (ผ่านตรวจ colorblind-safe แล้ว) — เรียงตามลำดับประเภทใน LeaveTypes
const TYPE_PALETTE = ['#12A171', '#4A8FD9', '#C98A16', '#7C6BD9', '#C2547C'];
function typeColor(typeId) {
  const i = state.types.findIndex((t) => t.type_id === typeId);
  return TYPE_PALETTE[i >= 0 ? i % TYPE_PALETTE.length : 0];
}

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
  $('#topbar-user').textContent = firstName(state.profile.name).slice(0, 2);
  $('#topbar-date').textContent = new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });

  const role = state.profile.role;
  if (role === 'approver' || role === 'admin') $('[data-view="approve"]').classList.remove('hidden');
  if (role === 'admin') {
    $('[data-view="dashboard"]').classList.remove('hidden');
    $('[data-view="staff"]').classList.remove('hidden');
  }

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
  $('#topbar-title').textContent = name === 'home'
    ? 'สวัสดี, ' + firstName(state.profile.name)
    : VIEW_TITLE[name];
  if (name === 'history') loadHistory();
  if (name === 'mydash') loadMyDash();
  if (name === 'approve') loadPending();
  if (name === 'dashboard') loadDashboard();
  if (name === 'staff') loadStaff();
  if (name === 'profile') renderProfile();
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

// ---------- ข้อมูลของฉัน + เปลี่ยน PIN ----------

$('#topbar-user').addEventListener('click', () => switchView('profile'));

function renderProfile() {
  const p = state.profile;
  const initials = firstName(p.name).slice(0, 2);
  const row = (label, val) => `<tr><td>${label}</td><td>${esc(val || '-')}</td></tr>`;
  $('#profile-card').innerHTML = `
    <div class="profile-head">
      <div class="profile-avatar">${esc(initials)}</div>
      <div>
        <div style="font-weight:600">${esc(p.name)}</div>
        <span class="badge ${p.role === 'admin' ? 'approved' : p.role === 'approver' ? 'pending' : 'cancelled'}">${ROLE_TH[p.role] || esc(p.role)}</span>
      </div>
    </div>
    <table class="profile-rows">
      ${row('รหัสพนักงาน', p.emp_id)}
      ${row('แผนก', p.dept)}
      ${row('อีเมล', p.email)}
      ${row('เบอร์โทร', p.phone)}
      ${row('หัวหน้าผู้อนุมัติ', p.manager_name || (p.manager_id ? p.manager_id : 'ไม่ระบุ (admin อนุมัติแทน)'))}
    </table>
    <p class="muted" style="font-size:12px;margin:10px 0 0">ข้อมูลไม่ถูกต้อง แจ้ง HR/แอดมินให้แก้ไขได้</p>`;
}

$('#pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#p-new').value !== $('#p-new2').value) return toast('PIN ใหม่สองช่องไม่ตรงกัน', true);
  const btn = $('#p-submit');
  btn.disabled = true;
  try {
    await api('changePin', { old_pin: $('#p-old').value, new_pin: $('#p-new').value });
    toast('เปลี่ยน PIN เรียบร้อย ใช้ PIN ใหม่ในการ login ครั้งถัดไป ✓');
    $('#pin-form').reset();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- หน้าหลัก: วันลาคงเหลือ + ฟอร์ม ----------

function renderBalances() {
  $('#balance-cards').innerHTML = state.balances
    .filter((b) => b.quota !== null)
    .map((b) => {
      const pct = b.quota > 0 ? Math.max(0, Math.min(100, (b.remaining / b.quota) * 100)) : 0;
      return `
      <div class="balance-card">
        <div class="b-name">${esc(b.name)}</div>
        <div class="b-num">${fmtNum(b.remaining)}</div>
        <div class="b-sub">เหลือจาก ${fmtNum(b.quota)} วัน${b.pending ? ` · รอ ${fmtNum(b.pending)}` : ''}</div>
        <div class="b-bar"><div class="b-fill" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
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

  const editing = state.editingReq;
  const btn = $('#f-submit');
  btn.disabled = true;
  try {
    const res = await api(editing ? 'updateRequest' : 'submit', {
      req_id: editing || undefined,
      type_id: $('#f-type').value,
      start: $('#f-start').value,
      end: $('#f-end').value,
      half_day: $('#f-half').checked,
      reason: $('#f-reason').value.trim(),
      file,
    });
    toast(editing
      ? `แก้ไขใบลาเรียบร้อย (${fmtNum(res.days)} วัน) รอหัวหน้าอนุมัติ ✓`
      : `ส่งใบลาเรียบร้อย (${fmtNum(res.days)} วัน) รอหัวหน้าอนุมัติ ✓`);
    resetLeaveForm();
    applyBundle(await api('me', {}, true));
    renderBalances();
    switchView('history');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// โหมดแก้ไขใบลา (กรณีลาผิดวัน) — ใช้ฟอร์มยื่นลาเดิม เติมข้อมูลใบเก่าให้
function editReq(reqId) {
  const r = state.myRequests.find((x) => x.req_id === reqId);
  if (!r || r.status !== 'pending') return;
  state.editingReq = reqId;
  switchView('home');
  $('#f-type').value = r.type_id;
  $('#f-start').value = r.start_date;
  $('#f-end').value = r.end_date;
  onDatesChange();
  if (r.half_day && r.start_date === r.end_date) {
    $('#f-half').checked = true;
    onDatesChange();
  }
  $('#f-reason').value = r.reason || '';
  $('#f-file').value = '';
  $('#leave-form-title').textContent = 'แก้ไขใบลา (รออนุมัติ)';
  $('#f-submit').textContent = 'บันทึกการแก้ไข';
  $('#f-cancel-edit').classList.remove('hidden');
  $('#leave-form').scrollIntoView({ behavior: 'smooth' });
}

function resetLeaveForm() {
  state.editingReq = null;
  $('#f-reason').value = '';
  $('#f-file').value = '';
  $('#f-half').checked = false;
  initFormDates();
  $('#leave-form-title').textContent = 'ยื่นใบลา';
  $('#f-submit').textContent = 'ส่งใบลา';
  $('#f-cancel-edit').classList.add('hidden');
}

$('#f-cancel-edit').addEventListener('click', () => {
  resetLeaveForm();
  switchView('history');
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
    state.myRequests = res.requests;
    if (!res.requests.length) {
      box.innerHTML = '<div class="empty">ยังไม่มีประวัติการลา</div>';
      return;
    }
    const today = fmtDate(new Date());
    box.innerHTML = res.requests.map((r) => {
      const canEdit = r.status === 'pending';
      // ยกเลิกได้: รออนุมัติ หรืออนุมัติแล้วแต่ยังไม่ถึงวันเริ่มลา
      const canCancel = r.status === 'pending' || (r.status === 'approved' && r.start_date > today);
      return `
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
        ${canEdit || canCancel ? `
        <div class="req-actions">
          ${canEdit ? `<button class="btn" onclick="editReq('${esc(r.req_id)}')">✏️ แก้ไข</button>` : ''}
          ${canCancel ? `<button class="btn danger" onclick="cancelReq('${esc(r.req_id)}')">ยกเลิกใบลา</button>` : ''}
        </div>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function cancelReq(reqId) {
  const r = state.myRequests.find((x) => x.req_id === reqId);
  const msg = r && r.status === 'approved'
    ? 'ใบลานี้อนุมัติแล้ว ยืนยันยกเลิก? ระบบจะคืนวันลาและแจ้งหัวหน้าให้ทราบ'
    : 'ยืนยันยกเลิกใบลานี้?';
  if (!confirm(msg)) return;
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

// ---------- สรุปของฉัน (ทุกคน) ----------

async function loadMyDash() {
  try {
    const res = await api('myRequests');
    state.myRequests = res.requests;
    renderMyHero();
    renderMyNudge();
    renderMyUpcoming();
    renderMyTrend();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderMyHero() {
  const quotaTypes = state.balances.filter((b) => b.quota !== null);
  const totalRemaining = quotaTypes.reduce((s, b) => s + b.remaining, 0);
  const totalQuota = quotaTypes.reduce((s, b) => s + b.quota, 0);
  const totalUsed = quotaTypes.reduce((s, b) => s + b.used, 0);
  const totalPending = quotaTypes.reduce((s, b) => s + b.pending, 0);
  const rows = quotaTypes.map((b) => {
    const pct = b.quota > 0 ? Math.min(100, (b.used / b.quota) * 100) : 0;
    const color = typeColor(b.type_id);
    return `
    <div class="tr-row">
      <span class="tr-dot" style="background:${color}"></span>
      <span class="tr-name">${esc(b.name)}</span>
      <div class="tr-bar"><div class="tr-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="tr-val">${fmtNum(b.used)}/${fmtNum(b.quota)}</span>
    </div>`;
  }).join('');
  $('#my-hero').innerHTML = `
    <p class="my-label">วันลาคงเหลือรวมปีนี้</p>
    <p class="my-total">${fmtNum(totalRemaining)} <span>วัน จากสิทธิ์ ${fmtNum(totalQuota)}</span></p>
    <p class="my-sub">ใช้ไป ${fmtNum(totalUsed)} วัน${totalPending ? ` · รออนุมัติ ${fmtNum(totalPending)} วัน` : ''}</p>
    ${rows}`;
}

// เตือนให้ใช้สิทธิ์: ครึ่งปีหลัง + พักร้อน (VAC) ยังเหลือ
function renderMyNudge() {
  const box = $('#my-nudge');
  const vac = state.balances.find((b) => b.type_id === 'VAC');
  const now = new Date();
  if (!vac || vac.quota === null || vac.remaining <= 0 || now.getMonth() + 1 < 7) {
    box.innerHTML = '';
    return;
  }
  const yearEnd = new Date(now.getFullYear(), 11, 31);
  const daysLeft = Math.ceil((yearEnd - now) / 86400000);
  box.innerHTML = `
    <div class="alert-card warn">
      <p class="alert-title">🔔 ${esc(vac.name)}เหลือ ${fmtNum(vac.remaining)} วัน — สิทธิ์หมดสิ้นปีนี้ (อีก ${daysLeft} วัน)</p>
    </div>`;
}

function renderMyUpcoming() {
  const today = fmtDate(new Date());
  const list = state.myRequests
    .filter((r) => r.status === 'pending' || (r.status === 'approved' && r.end_date >= today))
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  $('#my-upcoming').innerHTML = list.length
    ? list.map((r) => {
      const daysTo = Math.ceil((parseDate(r.start_date) - parseDate(today)) / 86400000);
      const waiting = r.created_at ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) : NaN;
      const note = r.status === 'pending'
        ? (isNaN(waiting) ? '' : (waiting > 0 ? ` · รอมาแล้ว ${waiting} วัน` : ' · ยื่นวันนี้'))
        : (daysTo > 0 ? ` (อีก ${daysTo} วัน)` : ' (กำลังลาอยู่)');
      return `
      <div class="up-row">
        <span class="up-name">${esc(typeName(r.type_id))} <span class="up-date">${fmtThai(r.start_date)}${r.start_date !== r.end_date ? ' – ' + fmtThai(r.end_date) : ''}${note}</span></span>
        <span class="badge ${esc(r.status)}">${STATUS_TH[r.status] || esc(r.status)}</span>
      </div>`;
    }).join('')
    : '<div class="empty" style="padding:16px 0">ไม่มีใบลาค้างอยู่ — ยื่นใบใหม่ได้ที่แท็บยื่นลา</div>';
}

function renderMyTrend() {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const days = state.myRequests
      .filter((r) => r.status === 'approved' && String(r.start_date).slice(0, 7) === ym)
      .reduce((s, r) => s + (Number(r.days) || 0), 0);
    months.push({ ym, days, name: d.toLocaleDateString('th-TH', { month: 'short' }) });
  }
  const max = Math.max(1, ...months.map((m) => m.days));
  const last = months.length - 1;
  $('#my-trend').innerHTML =
    `<div class="trend-bars">${months.map((m, i) =>
      `<div class="${i === last ? 'cur' : ''}" style="height:${Math.round((m.days / max) * 70) + 6}px" title="${esc(m.ym)}: ${fmtNum(m.days)} วัน"></div>`).join('')}</div>` +
    `<div class="trend-lbls">${months.map((m, i) =>
      `<span class="${i === last ? 'cur' : ''}">${esc(m.name)}</span>`).join('')}</div>`;
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
    renderHoliday(res);
    renderAlerts(res);
    renderDashStats(res);
    renderTrend(res);
    renderCalendar();
    renderUpcoming(res);
    renderDashTable(res);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderHoliday(res) {
  const el = $('#dash-holiday');
  if (!res.next_holiday) return el.classList.add('hidden');
  const h = res.next_holiday;
  el.textContent = `📅 วันหยุดถัดไป · ${h.name} (${fmtThai(h.date)}) — อีก ${h.days_until} วัน`;
  el.classList.remove('hidden');
}

function renderAlerts(res) {
  let html = '';
  (res.clashes || []).forEach((c) => {
    html += `
    <div class="alert-card hot">
      <p class="alert-title">⚠️ ${fmtThai(c.date)} — คนลาพร้อมกัน ${c.count} คน</p>
      <p class="alert-sub">${esc(c.names.join(', '))}</p>
    </div>`;
  });
  const aging = res.aging || [];
  if (aging.length) {
    const days = res.alert_settings ? res.alert_settings.pending_days : 3;
    html += `
    <div class="alert-card warn">
      <p class="alert-title">⏳ ใบลาค้างเกิน ${days} วัน — ${aging.length} ใบ</p>
      <p class="alert-sub">${aging.slice(0, 3).map((a) =>
        `${esc(a.emp_name)} รอ ${a.waiting_days} วัน${a.approver_name ? ' (รอ' + esc(a.approver_name) + ')' : ''}`).join(' · ')}${aging.length > 3 ? ` และอีก ${aging.length - 3} ใบ` : ''}</p>
    </div>`;
  }
  $('#dash-alerts').innerHTML = html;
}

function renderDashStats(res) {
  const onLeave = res.stats.onLeaveToday;
  const third = res.used_percent != null
    ? `<div class="s-num">${res.used_percent}%</div><div class="s-label">ใช้ไปจากสิทธิ์รวม</div>`
    : `<div class="s-num">${fmtNum(res.stats.usedTotal)}</div><div class="s-label">วันลาที่ใช้ปีนี้</div>`;
  $('#dash-stats').innerHTML = `
    <div class="stat-card"><div class="s-num warn-c">${res.stats.pending}</div><div class="s-label">รออนุมัติ</div></div>
    <div class="stat-card" title="${esc(onLeave.join(', '))}"><div class="s-num ok-c">${onLeave.length}</div><div class="s-label">ลาวันนี้${onLeave.length ? '<br>' + esc(onLeave.map(firstName).join(', ')) : ''}</div></div>
    <div class="stat-card">${third}</div>`;
}

function renderTrend(res) {
  const card = $('#trend-card');
  if (!res.monthly || !res.monthly.length) return card.classList.add('hidden');
  card.classList.remove('hidden');
  const max = Math.max(1, ...res.monthly.map((m) => m.days));
  const last = res.monthly.length - 1;
  const bars = res.monthly.map((m, i) =>
    `<div class="${i === last ? 'cur' : ''}" style="height:${Math.round((m.days / max) * 70) + 6}px" title="${esc(m.ym)}: ${fmtNum(m.days)} วัน"></div>`).join('');
  const lbls = res.monthly.map((m, i) => {
    const [y, mm] = m.ym.split('-').map(Number);
    const name = new Date(y, mm - 1, 1).toLocaleDateString('th-TH', { month: 'short' });
    return `<span class="${i === last ? 'cur' : ''}">${esc(name)}</span>`;
  }).join('');
  $('#dash-trend').innerHTML = `<div class="trend-bars">${bars}</div><div class="trend-lbls">${lbls}</div>`;
}

function renderCalendar() {
  const res = state.dashboard;
  const clashN = res.alert_settings ? res.alert_settings.clash_people : 3;
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  $('#cal-title').textContent = state.calMonth.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = fmtDate(new Date());

  let html = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((d) => `<span class="dw">${d}</span>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<span></span>';

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = fmtDate(new Date(y, m, day));
    const dow = new Date(y, m, day).getDay();
    const isOff = !state.workAllWeek && (dow === 0 || dow === 6 || state.holidays.has(ds));
    const covering = isOff ? [] : res.leaves.filter((l) => l.start_date <= ds && ds <= l.end_date);
    const names = [...new Set(covering.map((l) => l.emp_name))];
    const approvedRows = covering.filter((l) => l.status === 'approved');

    let cls = '';
    if (names.length >= clashN) cls = 'hot';
    else if (approvedRows.length) cls = approvedRows[0].type_id === 'SICK' ? 'p2' : 'on';
    else if (covering.length) cls = 'pn';
    if (isOff) cls += ' off';
    if (ds === today) cls += ' td';
    if (names.length) cls += ' has';

    const click = names.length
      ? ` onclick="toast('${esc(fmtThai(ds))}: ${esc(names.join(', '))}')"`
      : '';
    html += `<span class="${cls.trim()}"${click}>${day}</span>`;
  }
  $('#calendar').innerHTML = `<div class="cal7">${html}</div>`;
}

function renderUpcoming(res) {
  const today = fmtDate(new Date());
  const limit = fmtDate(new Date(Date.now() + 14 * 86400000));
  const list = res.leaves
    .filter((l) => l.end_date >= today && l.start_date <= limit)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1))
    .slice(0, 8);
  $('#dash-upcoming').innerHTML = list.length
    ? list.map((l) => `
      <div class="up-row">
        <span class="up-name">${esc(l.emp_name)} <span class="up-date">${fmtThai(l.start_date)}${l.start_date !== l.end_date ? ' – ' + fmtThai(l.end_date) : ''}</span></span>
        <span class="badge ${l.status === 'pending' ? 'pending' : 'approved'}">${l.status === 'pending' ? 'รออนุมัติ' : esc(typeName(l.type_id))}</span>
      </div>`).join('')
    : '<div class="empty" style="padding:16px 0">ไม่มีใครลาช่วง 14 วันนี้</div>';
}

$('#dash-export').addEventListener('click', async () => {
  const btn = $('#dash-export');
  btn.disabled = true;
  try {
    const res = await api('report');
    const head = ['เลขที่ใบลา', 'รหัสพนักงาน', 'ชื่อ', 'ประเภท', 'วันเริ่ม', 'วันสิ้นสุด', 'จำนวนวัน', 'สถานะ', 'ผู้อนุมัติ', 'ยื่นเมื่อ', 'เหตุผล'];
    const rows = res.rows.map((r) => [r.req_id, r.emp_id, r.emp_name, typeName(r.type_id), r.start_date, r.end_date,
      r.days, STATUS_TH[r.status] || r.status, r.approver_id, r.created_at, r.reason]);
    const csv = [head].concat(rows)
      .map((cols) => cols.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    // นำหน้าด้วย UTF-8 BOM เพื่อให้ Excel เปิดภาษาไทยไม่เพี้ยน
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leave-report-${res.year}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`ดาวน์โหลดรายงานปี ${res.year} แล้ว (${res.rows.length} รายการ)`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

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

// ---------- จัดการพนักงาน (HR/admin) ----------

async function loadStaff() {
  const box = $('#staff-list');
  box.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const res = await api('employees', {}, true);
    state.staff = res;
    renderStaffList(res);
    renderManagerOptions(res);
    renderQuotaInputs(res.types);
    resetEmpForm();
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function renderStaffList(res) {
  const badge = { employee: 'cancelled', approver: 'pending', admin: 'approved' };
  $('#staff-list').innerHTML = res.employees.map((e) => {
    const mgr = res.employees.find((x) => x.emp_id === e.manager_id);
    const quotaNote = Object.keys(e.quotas).length
      ? `<br><span style="color:var(--primary)">มีสิทธิ์วันลาเฉพาะคน: ${Object.keys(e.quotas)
          .map((tid) => `${esc(typeNameOf(res.types, tid))} ${fmtNum(e.quotas[tid])} วัน`).join(', ')}</span>`
      : '';
    return `
      <div class="req-card">
        <div class="req-top">
          <span class="req-title">${esc(e.name)}</span>
          <span class="badge ${badge[e.role] || 'cancelled'}">${ROLE_TH[e.role] || esc(e.role)}</span>
        </div>
        <div class="req-meta">
          ${esc(e.emp_id)}${e.dept ? ' · ' + esc(e.dept) : ''}${e.email ? ' · ' + esc(e.email) : ''}${e.phone ? ' · 📞 ' + esc(e.phone) : ''}<br>
          หัวหน้า: ${mgr ? esc(mgr.name) : '<i>ไม่ระบุ (admin อนุมัติแทน)</i>'}${quotaNote}
        </div>
        <div class="req-actions">
          <button type="button" class="btn" onclick="editEmp('${esc(e.emp_id)}')">✏️ แก้ไข</button>
        </div>
      </div>`;
  }).join('');
}

function renderManagerOptions(res) {
  $('#e-manager').innerHTML = '<option value="">— ไม่ระบุ (admin อนุมัติแทน) —</option>'
    + res.employees.map((e) => `<option value="${esc(e.emp_id)}">${esc(e.name)} (${esc(e.emp_id)})</option>`).join('');
}

function renderQuotaInputs(types) {
  const quotaTypes = types.filter((t) => t.quota_days !== '' && t.quota_days !== null);
  $('#e-quotas').innerHTML = `
    <p class="muted" style="font-size:13px;margin:4px 0 8px">สิทธิ์วันลาต่อปีเฉพาะคนนี้ — เว้นว่าง = ใช้ค่ามาตรฐานของบริษัท</p>
    <div class="row2">
      ${quotaTypes.map((t) => `
        <label>${esc(t.name)}
          <input type="number" min="0" step="0.5" data-quota="${esc(t.type_id)}" placeholder="มาตรฐาน ${fmtNum(t.quota_days)}">
        </label>`).join('')}
    </div>`;
}

function editEmp(empId) {
  const e = state.staff.employees.find((x) => x.emp_id === empId);
  if (!e) return;
  state.editingEmp = empId;
  $('#emp-form-title').textContent = 'แก้ไข: ' + e.name;
  $('#e-id').value = e.emp_id;
  $('#e-id').disabled = true;
  $('#e-pin').required = false;
  $('#e-pin').value = '';
  $('#e-pin').placeholder = 'เว้นว่าง = ใช้ PIN เดิม';
  $('#e-pin-label').firstChild.textContent = 'ตั้ง PIN ใหม่ ';
  $('#e-name').value = e.name;
  $('#e-dept').value = e.dept || '';
  $('#e-email').value = e.email || '';
  $('#e-phone').value = e.phone || '';
  $('#e-role').value = e.role || 'employee';
  $('#e-manager').value = e.manager_id || '';
  $$('#e-quotas [data-quota]').forEach((inp) => {
    const v = e.quotas[inp.dataset.quota];
    inp.value = v == null ? '' : v;
  });
  $('#e-submit').textContent = 'บันทึกการแก้ไข';
  $('#e-cancel').classList.remove('hidden');
  $('#emp-form').scrollIntoView({ behavior: 'smooth' });
}

function resetEmpForm() {
  state.editingEmp = null;
  $('#emp-form').reset();
  $('#emp-form-title').textContent = 'เพิ่มพนักงานใหม่';
  $('#e-id').disabled = false;
  $('#e-pin').required = true;
  $('#e-pin').placeholder = 'เช่น 1234';
  $('#e-pin-label').firstChild.textContent = 'PIN (ตัวเลข 4-8 หลัก) ';
  $('#e-submit').textContent = 'เพิ่มพนักงาน';
  $('#e-cancel').classList.add('hidden');
}

$('#e-cancel').addEventListener('click', resetEmpForm);

$('#emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const quotas = {};
  $$('#e-quotas [data-quota]').forEach((inp) => { quotas[inp.dataset.quota] = inp.value.trim(); });
  const editing = state.editingEmp;
  const btn = $('#e-submit');
  btn.disabled = true;
  try {
    const res = await api(editing ? 'updateEmployee' : 'addEmployee', {
      emp_id: editing || $('#e-id').value.trim(),
      name: $('#e-name').value.trim(),
      dept: $('#e-dept').value.trim(),
      email: $('#e-email').value.trim(),
      phone: $('#e-phone').value.trim(),
      pin: $('#e-pin').value,
      role: $('#e-role').value,
      manager_id: $('#e-manager').value,
      quotas,
    });
    toast(editing ? `บันทึกข้อมูล ${res.emp_id} เรียบร้อย ✓` : `เพิ่มพนักงาน ${res.emp_id} เรียบร้อย ✓`);
    loadStaff();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function typeNameOf(types, typeId) {
  const t = types.find((x) => x.type_id === typeId);
  return t ? t.name : typeId;
}

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
