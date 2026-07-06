/**
 * ระบบแจ้งลางาน — backend บน Google Apps Script
 * วิธีติดตั้ง: ดู README.md (สรุป: เปิด Google Sheet > Extensions > Apps Script >
 * วางไฟล์นี้ > รัน setup() หนึ่งครั้ง > Deploy เป็น Web app)
 */

const SHEET = { EMP: 'Employees', REQ: 'LeaveRequests', TYPE: 'LeaveTypes', HOL: 'Holidays' };
const TZ = 'Asia/Bangkok';
const TOKEN_HOURS = 12;      // อายุ token หลัง login
const DECIDE_LINK_DAYS = 7;  // อายุลิงก์อนุมัติในอีเมล

// true  = บริษัททำงานทั้งสัปดาห์ นับวันลาทุกวัน (รวมเสาร์-อาทิตย์และวันหยุดในแท็บ Holidays)
// false = นับเฉพาะวันทำการ ข้ามเสาร์-อาทิตย์และวันหยุดในแท็บ Holidays
const WORK_ALL_WEEK = true;

// ---------- จุดรับ request ----------

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const handlers = {
      login: apiLogin_,
      me: apiMe_,
      submit: apiSubmit_,
      myRequests: apiMyRequests_,
      cancel: apiCancel_,
      pending: apiPending_,
      decide: apiDecide_,
      dashboard: apiDashboard_,
      addEmployee: apiAddEmployee_,
    };
    const fn = handlers[req.action];
    if (!fn) throw new Error('ไม่รู้จักคำสั่ง: ' + req.action);
    return json_(fn(req));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// ลิงก์อนุมัติจากอีเมล — เปิดหน้ายืนยันก่อนเสมอ ไม่เปลี่ยนสถานะจากการเปิดลิงก์ตรง ๆ
// เพราะระบบสแกนอีเมล (SafeLinks/แอนติไวรัส) จะเปิดลิงก์ในอีเมลอัตโนมัติ
// การอนุมัติจริงเกิดเมื่อกดปุ่มยืนยัน (JavaScript) ในหน้านั้นเท่านั้น
function doGet(e) {
  const p = e.parameter || {};
  if (p.action === 'decide') {
    try {
      const payload = verifyToken_(p.t); // 'decide|reqId|approverId'
      const parts = payload.split('|');
      if (parts[0] !== 'decide' || parts[1] !== p.r) throw new Error('ลิงก์ไม่ถูกต้อง');
      const decision = p.d === 'approved' ? 'approved' : 'rejected';
      const found = findReq_(p.r);
      if (!found) throw new Error('ไม่พบใบลา');
      if (found.obj.status !== 'pending') {
        return page_('ℹ️ ใบลานี้ถูกดำเนินการไปแล้ว (สถานะ: ' + statusTh_(found.obj.status) + ')');
      }
      if (p.confirm !== '1') return confirmPage_(found.obj, decision, p);
      decide_(p.r, decision, parts[2], '');
      return page_(decision === 'approved' ? '✅ อนุมัติใบลาเรียบร้อยแล้ว' : '❌ บันทึกไม่อนุมัติเรียบร้อยแล้ว');
    } catch (err) {
      return page_('⚠️ ' + String(err.message || err));
    }
  }
  return json_({ ok: true, service: 'leave-system' });
}

function page_(msg) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;text-align:center;padding:48px 16px;font-size:20px">' + msg +
    '<br><br><span style="font-size:14px;color:#666">ปิดหน้านี้ได้เลย</span></div>'
  );
}

function confirmPage_(reqObj, decision, p) {
  const type = rows_(SHEET.TYPE).filter(t => t.type_id === reqObj.type_id)[0];
  const approve = decision === 'approved';
  const url = ScriptApp.getService().getUrl()
    + '?action=decide&r=' + encodeURIComponent(p.r)
    + '&d=' + encodeURIComponent(decision)
    + '&t=' + encodeURIComponent(p.t) + '&confirm=1';
  const color = approve ? '#0F6E56' : '#A32D2D';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;max-width:420px;margin:32px auto;padding:0 16px;text-align:center">' +
    '<h2 style="color:' + color + '">' + (approve ? 'ยืนยันการอนุมัติใบลา' : 'ยืนยันการไม่อนุมัติใบลา') + '</h2>' +
    '<div style="background:#F5F6F4;border-radius:12px;padding:16px;text-align:left;line-height:1.9">' +
    '<b>' + esc_(reqObj.emp_name) + '</b> (' + esc_(reqObj.emp_id) + ')<br>' +
    esc_(type ? type.name : reqObj.type_id) + ' รวม <b>' + esc_(reqObj.days) + ' วันทำการ</b><br>' +
    'วันที่ ' + esc_(reqObj.start_date) + ' ถึง ' + esc_(reqObj.end_date) + '<br>' +
    'เหตุผล: ' + esc_(reqObj.reason || '-') +
    (reqObj.file_url ? '<br><a href="' + esc_(reqObj.file_url) + '" target="_blank">📎 เปิดไฟล์แนบ</a>' : '') +
    '</div>' +
    '<button onclick="this.disabled=true;this.textContent=\'กำลังบันทึก…\';window.top.location.href=\'' + url + '\'" ' +
    'style="margin-top:24px;padding:14px 40px;font-size:17px;border:none;border-radius:8px;cursor:pointer;color:#fff;background:' + color + '">' +
    (approve ? '✓ ยืนยันอนุมัติ' : '✕ ยืนยันไม่อนุมัติ') + '</button>' +
    '<p style="color:#888;font-size:13px;margin-top:16px">ถ้ากดผิดปุ่มจากอีเมล ปิดหน้านี้ได้เลย จะยังไม่มีอะไรถูกบันทึก</p></div>'
  );
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- ติดตั้งครั้งแรก ----------

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) {
    props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!props.getProperty('FOLDER_ID')) {
    const folder = DriveApp.createFolder('ระบบลางาน-ไฟล์แนบ');
    props.setProperty('FOLDER_ID', folder.getId());
  }

  ensureSheet_(SHEET.TYPE,
    ['type_id', 'name', 'quota_days'],
    [
      ['VAC', 'ลาพักร้อน', 6],
      ['SICK', 'ลาป่วย', 30],
      ['PER', 'ลากิจ', 3],
      ['OTH', 'อื่น ๆ (ไม่จำกัด)', ''],
    ]);

  ensureSheet_(SHEET.HOL,
    ['date', 'name'],
    [
      ['2026-01-01', 'วันขึ้นปีใหม่'],
      ['2026-04-06', 'วันจักรี'],
      ['2026-04-13', 'วันสงกรานต์'],
      ['2026-04-14', 'วันสงกรานต์'],
      ['2026-04-15', 'วันสงกรานต์'],
      ['2026-05-01', 'วันแรงงาน'],
      ['2026-05-04', 'วันฉัตรมงคล'],
      ['2026-06-03', 'วันเฉลิมพระชนมพรรษาพระราชินี'],
      ['2026-07-28', 'วันเฉลิมพระชนมพรรษา ร.10'],
      ['2026-08-12', 'วันแม่แห่งชาติ'],
      ['2026-10-13', 'วันนวมินทรมหาราช'],
      ['2026-10-23', 'วันปิยมหาราช'],
      ['2026-12-05', 'วันพ่อแห่งชาติ'],
      ['2026-12-10', 'วันรัฐธรรมนูญ'],
      ['2026-12-31', 'วันสิ้นปี'],
      // หมายเหตุ: วันหยุดทางพุทธศาสนา (มาฆบูชา วิสาขบูชา ฯลฯ) และวันหยุดชดเชย ให้เติมเองตามประกาศแต่ละปี
    ]);

  ensureSheet_(SHEET.EMP,
    ['emp_id', 'name', 'dept', 'email', 'pin_hash', 'role', 'manager_id'],
    [
      ['EMP001', 'สมชาย ใจดี', 'IT', 'somchai@example.com', hashPin_('EMP001', '1234'), 'employee', 'EMP010'],
      ['EMP010', 'สมหญิง รักงาน', 'IT', 'somying@example.com', hashPin_('EMP010', '1234'), 'approver', ''],
      ['EMP999', 'ฝ่ายบุคคล', 'HR', 'hr@example.com', hashPin_('EMP999', '1234'), 'admin', ''],
    ]);

  ensureSheet_(SHEET.REQ,
    ['req_id', 'created_at', 'emp_id', 'emp_name', 'type_id', 'start_date', 'end_date',
     'half_day', 'days', 'reason', 'file_url', 'status', 'approver_id', 'decided_at', 'comment'],
    []);

  Logger.log('ติดตั้งเสร็จแล้ว! อย่าลืม: 1) แก้ข้อมูลพนักงานในแท็บ Employees ให้เป็นของจริง'
    + ' 2) เปลี่ยน PIN ด้วยฟังก์ชัน setPin 3) Deploy เป็น Web app');
}

/** เปลี่ยน PIN ของพนักงาน — แก้ค่าสองตัวนี้แล้วกด Run ในหน้า Apps Script */
function setPin() {
  const EMP_ID = 'EMP001';
  const NEW_PIN = '1234';
  const sh = ss_().getSheetByName(SHEET.EMP);
  const data = sh.getDataRange().getValues();
  const head = data[0];
  const col = head.indexOf('pin_hash') + 1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][head.indexOf('emp_id')]).trim() === EMP_ID) {
      sh.getRange(i + 1, col).setValue(hashPin_(EMP_ID, NEW_PIN));
      Logger.log('เปลี่ยน PIN ของ ' + EMP_ID + ' เรียบร้อย');
      return;
    }
  }
  Logger.log('ไม่พบรหัสพนักงาน ' + EMP_ID);
}

function ensureSheet_(name, headers, sampleRows) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (sampleRows.length) {
      sh.getRange(2, 1, sampleRows.length, headers.length).setNumberFormat('@')
        .setValues(sampleRows);
    }
    // บังคับคอลัมน์วันที่เป็นข้อความ กัน Sheets แปลงเป็น Date อัตโนมัติ
    headers.forEach((h, i) => {
      if (h === 'date' || h.indexOf('_date') > -1 || h.indexOf('_at') > -1) {
        sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      }
    });
  }
}

// ---------- API: ผู้ใช้ ----------

function apiLogin_(req) {
  const empId = String(req.emp_id || '').trim().toUpperCase();
  const emp = findEmp_(empId);
  if (!emp || emp.pin_hash !== hashPin_(empId, String(req.pin || ''))) {
    throw new Error('รหัสพนักงานหรือ PIN ไม่ถูกต้อง');
  }
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const token = signToken_('auth|' + emp.emp_id, exp);
  return bundle_(emp, token);
}

function apiMe_(req) {
  const emp = auth_(req.token);
  return bundle_(emp, req.token);
}

function bundle_(emp, token) {
  return {
    ok: true,
    token: token,
    profile: { emp_id: emp.emp_id, name: emp.name, dept: emp.dept, role: emp.role },
    types: rows_(SHEET.TYPE),
    holidays: rows_(SHEET.HOL).map(h => fmtD_(h.date)),
    balances: balances_(emp.emp_id),
    work_all_week: WORK_ALL_WEEK,
  };
}

// ---------- API: ยื่นลา ----------

function apiSubmit_(req) {
  const emp = auth_(req.token);
  const type = rows_(SHEET.TYPE).filter(t => t.type_id === req.type_id)[0];
  if (!type) throw new Error('ประเภทการลาไม่ถูกต้อง');

  const start = String(req.start || '');
  const end = String(req.end || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  if (end < start) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  const halfDay = !!req.half_day;
  if (halfDay && start !== end) throw new Error('ลาครึ่งวันได้เมื่อเลือกวันเดียวเท่านั้น');

  const holidays = {};
  rows_(SHEET.HOL).forEach(h => holidays[fmtD_(h.date)] = true);
  const days = countDays_(start, end, halfDay, holidays);
  if (days <= 0) throw new Error('ช่วงที่เลือกไม่มีวันทำการ (ตรงวันหยุดทั้งหมด)');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // เช็กโควตา (นับทั้งที่อนุมัติแล้วและที่รออนุมัติ กันยื่นเกินสิทธิ์)
    const quota = type.quota_days === '' || type.quota_days === null ? null : Number(type.quota_days);
    if (quota !== null) {
      const b = balances_(emp.emp_id).filter(x => x.type_id === type.type_id)[0];
      if (b.used + b.pending + days > quota) {
        throw new Error('วันลาคงเหลือไม่พอ (' + type.name + ' เหลือ ' + (quota - b.used - b.pending) + ' วัน)');
      }
    }

    // อัปโหลดไฟล์แนบ (เช่น ใบรับรองแพทย์) ขึ้น Google Drive
    let fileUrl = '';
    if (req.file && req.file.data) {
      const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
      const blob = Utilities.newBlob(Utilities.base64Decode(req.file.data), req.file.mime || 'application/octet-stream',
        emp.emp_id + '_' + start + '_' + (req.file.name || 'attachment'));
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      fileUrl = file.getUrl();
    }

    const reqId = 'REQ-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss') + '-' + emp.emp_id;
    const sh = ss_().getSheetByName(SHEET.REQ);
    sh.appendRow([reqId, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), emp.emp_id, emp.name,
      type.type_id, start, end, halfDay ? 'TRUE' : '', days, String(req.reason || ''), fileUrl,
      'pending', '', '', '']);

    notifyManager_(emp, { req_id: reqId, type_name: type.name, start: start, end: end, days: days, reason: req.reason, file_url: fileUrl });
    return { ok: true, req_id: reqId, days: days };
  } finally {
    lock.releaseLock();
  }
}

function apiMyRequests_(req) {
  const emp = auth_(req.token);
  const list = reqs_().filter(r => r.emp_id === emp.emp_id).reverse();
  return { ok: true, requests: list };
}

function apiCancel_(req) {
  const emp = auth_(req.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const found = findReq_(req.req_id);
    if (!found || found.obj.emp_id !== emp.emp_id) throw new Error('ไม่พบใบลา');
    if (found.obj.status !== 'pending') throw new Error('ยกเลิกได้เฉพาะใบลาที่รออนุมัติ');
    setReqCells_(found.row, { status: 'cancelled', decided_at: now_() });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------- API: อนุมัติ ----------

function apiPending_(req) {
  const emp = auth_(req.token);
  requireRole_(emp, ['approver', 'admin']);
  const emps = rows_(SHEET.EMP);
  const list = reqs_().filter(r => {
    if (r.status !== 'pending') return false;
    if (emp.role === 'admin') return true;
    const owner = emps.filter(x => x.emp_id === r.emp_id)[0];
    return owner && String(owner.manager_id).trim() === emp.emp_id;
  });
  return { ok: true, requests: list };
}

function apiDecide_(req) {
  const emp = auth_(req.token);
  requireRole_(emp, ['approver', 'admin']);
  if (emp.role !== 'admin') {
    const found = findReq_(req.req_id);
    if (!found) throw new Error('ไม่พบใบลา');
    const owner = findEmp_(found.obj.emp_id);
    if (!owner || String(owner.manager_id).trim() !== emp.emp_id) throw new Error('ไม่มีสิทธิ์อนุมัติใบลานี้');
  }
  const decision = req.decision === 'approved' ? 'approved' : 'rejected';
  decide_(req.req_id, decision, emp.emp_id, String(req.comment || ''));
  return { ok: true };
}

function decide_(reqId, decision, approverId, comment) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const found = findReq_(reqId);
    if (!found) throw new Error('ไม่พบใบลา ' + reqId);
    if (found.obj.status !== 'pending') throw new Error('ใบลานี้ถูกดำเนินการไปแล้ว (สถานะ: ' + statusTh_(found.obj.status) + ')');
    setReqCells_(found.row, { status: decision, approver_id: approverId, decided_at: now_(), comment: comment });
    notifyEmployee_(found.obj, decision, comment);
  } finally {
    lock.releaseLock();
  }
}

// ---------- API: เพิ่มพนักงาน (HR/admin) ----------

function apiAddEmployee_(req) {
  const emp = auth_(req.token);
  requireRole_(emp, ['admin']);

  const id = String(req.emp_id || '').trim().toUpperCase();
  if (!/^[A-Z0-9\-_.]{2,20}$/.test(id)) throw new Error('รหัสพนักงานต้องเป็น A-Z หรือตัวเลข 2-20 ตัว');
  const name = String(req.name || '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อ-สกุล');
  const pin = String(req.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN ต้องเป็นตัวเลข 4-8 หลัก');
  const role = ['employee', 'approver', 'admin'].indexOf(req.role) > -1 ? req.role : 'employee';
  const managerId = String(req.manager_id || '').trim().toUpperCase();
  const email = String(req.email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (findEmp_(id)) throw new Error('มีรหัสพนักงาน ' + id + ' อยู่แล้ว');
    if (managerId && !findEmp_(managerId)) throw new Error('ไม่พบรหัสหัวหน้า ' + managerId);
    ss_().getSheetByName(SHEET.EMP)
      .appendRow([id, name, String(req.dept || '').trim(), email, hashPin_(id, pin), role, managerId]);
    return { ok: true, emp_id: id };
  } finally {
    lock.releaseLock();
  }
}

// ---------- API: dashboard (HR/admin) ----------

function apiDashboard_(req) {
  const emp = auth_(req.token);
  requireRole_(emp, ['admin']);

  const year = Utilities.formatDate(new Date(), TZ, 'yyyy');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const types = rows_(SHEET.TYPE);
  const emps = rows_(SHEET.EMP);
  const all = reqs_();
  const thisYear = all.filter(r => String(r.start_date).slice(0, 4) === year);
  const approved = thisYear.filter(r => r.status === 'approved');

  const typeUsage = types.map(t => ({
    type_id: t.type_id, name: t.name, quota: t.quota_days,
    used: sum_(approved.filter(r => r.type_id === t.type_id).map(r => Number(r.days) || 0)),
  }));

  const employees = emps.map(e => ({
    emp_id: e.emp_id, name: e.name, dept: e.dept,
    balances: balances_(e.emp_id),
  }));

  return {
    ok: true,
    types: types,
    stats: {
      pending: all.filter(r => r.status === 'pending').length,
      onLeaveToday: approved.filter(r => r.start_date <= today && today <= r.end_date).map(r => r.emp_name),
      usedTotal: sum_(approved.map(r => Number(r.days) || 0)),
    },
    typeUsage: typeUsage,
    employees: employees,
    // ใบลาปีนี้ (อนุมัติแล้ว + รออนุมัติ) สำหรับวาดปฏิทิน
    leaves: thisYear.filter(r => r.status === 'approved' || r.status === 'pending')
      .map(r => ({ emp_name: r.emp_name, type_id: r.type_id, start_date: r.start_date, end_date: r.end_date, status: r.status, days: r.days })),
  };
}

// ---------- นับวันลา (ข้ามเสาร์-อาทิตย์และวันหยุดบริษัท) ----------

function countDays_(startStr, endStr, halfDay, holidayMap) {
  let count = 0;
  const d = parseD_(startStr);
  const end = parseD_(endStr);
  while (d <= end) {
    const dow = d.getDay();
    const ds = fmtDate_(d);
    if (WORK_ALL_WEEK || (dow !== 0 && dow !== 6 && !holidayMap[ds])) count++;
    d.setDate(d.getDate() + 1);
  }
  if (halfDay && count === 1) count = 0.5;
  return count;
}

function balances_(empId) {
  const year = Utilities.formatDate(new Date(), TZ, 'yyyy');
  const mine = reqs_().filter(r => r.emp_id === empId && String(r.start_date).slice(0, 4) === year);
  return rows_(SHEET.TYPE).map(t => {
    const used = sum_(mine.filter(r => r.type_id === t.type_id && r.status === 'approved').map(r => Number(r.days) || 0));
    const pending = sum_(mine.filter(r => r.type_id === t.type_id && r.status === 'pending').map(r => Number(r.days) || 0));
    const quota = t.quota_days === '' || t.quota_days === null ? null : Number(t.quota_days);
    return { type_id: t.type_id, name: t.name, quota: quota, used: used, pending: pending,
      remaining: quota === null ? null : quota - used - pending };
  });
}

// ---------- อีเมลแจ้งเตือน ----------

function notifyManager_(emp, info) {
  const manager = findEmp_(String(emp.manager_id || '').trim());
  if (!manager || !manager.email) return;
  const url = ScriptApp.getService().getUrl();
  const exp = Date.now() + DECIDE_LINK_DAYS * 86400 * 1000;
  const t = signToken_('decide|' + info.req_id + '|' + manager.emp_id, exp);
  const approveUrl = url + '?action=decide&r=' + encodeURIComponent(info.req_id) + '&d=approved&t=' + encodeURIComponent(t);
  const rejectUrl = url + '?action=decide&r=' + encodeURIComponent(info.req_id) + '&d=rejected&t=' + encodeURIComponent(t);
  const btn = 'display:inline-block;padding:12px 28px;border-radius:8px;color:#fff;text-decoration:none;font-size:16px';
  MailApp.sendEmail({
    to: manager.email,
    subject: '[ใบลาใหม่] ' + emp.name + ' — ' + info.type_name + ' ' + info.days + ' วัน',
    htmlBody:
      '<div style="font-family:sans-serif;max-width:480px">' +
      '<h2 style="margin:0 0 12px">ใบลารออนุมัติ</h2>' +
      '<p><b>' + emp.name + '</b> (' + emp.emp_id + ') ขอ<b>' + info.type_name + '</b><br>' +
      'วันที่ ' + info.start + ' ถึง ' + info.end + ' รวม <b>' + info.days + ' วันทำการ</b><br>' +
      'เหตุผล: ' + (info.reason || '-') +
      (info.file_url ? '<br>ไฟล์แนบ: <a href="' + info.file_url + '">เปิดดู</a>' : '') + '</p>' +
      '<p style="margin:24px 0">' +
      '<a href="' + approveUrl + '" style="' + btn + ';background:#0F6E56">✓ อนุมัติ</a>&nbsp;&nbsp;' +
      '<a href="' + rejectUrl + '" style="' + btn + ';background:#A32D2D">✕ ไม่อนุมัติ</a></p>' +
      '<p style="color:#888;font-size:13px">กดปุ่มแล้วยืนยันอีกครั้งในหน้าที่เปิดขึ้น (ไม่ต้อง login) หรือเข้าไปจัดการในเว็บที่แท็บ "อนุมัติ"</p></div>',
  });
}

function notifyEmployee_(reqObj, decision, comment) {
  const emp = findEmp_(reqObj.emp_id);
  if (!emp || !emp.email) return;
  const approved = decision === 'approved';
  MailApp.sendEmail({
    to: emp.email,
    subject: '[ผลใบลา] ' + (approved ? 'อนุมัติแล้ว ✓' : 'ไม่อนุมัติ ✕') + ' — ' + reqObj.start_date + ' ถึง ' + reqObj.end_date,
    htmlBody:
      '<div style="font-family:sans-serif;max-width:480px">' +
      '<h2 style="margin:0 0 12px;color:' + (approved ? '#0F6E56' : '#A32D2D') + '">' +
      (approved ? 'ใบลาได้รับการอนุมัติ' : 'ใบลาไม่ได้รับการอนุมัติ') + '</h2>' +
      '<p>ใบลาวันที่ ' + reqObj.start_date + ' ถึง ' + reqObj.end_date + ' (' + reqObj.days + ' วัน)' +
      (comment ? '<br>หมายเหตุจากผู้อนุมัติ: ' + comment : '') + '</p></div>',
  });
}

// ---------- ตัวช่วยทั่วไป ----------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function sum_(arr) { return arr.reduce((a, b) => a + b, 0); }
function statusTh_(s) { return { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' }[s] || s; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function rows_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const head = v.shift();
  return v.filter(r => String(r[0]) !== '').map(r => {
    const o = {};
    head.forEach((h, i) => o[h] = r[i]);
    return o;
  });
}

function reqs_() {
  return rows_(SHEET.REQ).map(r => {
    r.start_date = fmtD_(r.start_date);
    r.end_date = fmtD_(r.end_date);
    r.emp_id = String(r.emp_id).trim();
    return r;
  });
}

function findEmp_(empId) {
  return rows_(SHEET.EMP).map(e => { e.emp_id = String(e.emp_id).trim(); return e; })
    .filter(e => e.emp_id === empId)[0] || null;
}

function findReq_(reqId) {
  const sh = ss_().getSheetByName(SHEET.REQ);
  const v = sh.getDataRange().getValues();
  const head = v[0];
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0]) === String(reqId)) {
      const o = {};
      head.forEach((h, j) => o[h] = v[i][j]);
      o.start_date = fmtD_(o.start_date);
      o.end_date = fmtD_(o.end_date);
      return { row: i + 1, obj: o, head: head };
    }
  }
  return null;
}

function setReqCells_(row, values) {
  const sh = ss_().getSheetByName(SHEET.REQ);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(values).forEach(k => {
    const col = head.indexOf(k) + 1;
    if (col > 0) sh.getRange(row, col).setValue(values[k]);
  });
}

function requireRole_(emp, roles) {
  if (roles.indexOf(emp.role) === -1) throw new Error('ไม่มีสิทธิ์ใช้งานส่วนนี้');
}

// วันที่: เก็บ/ส่งเป็นข้อความ yyyy-MM-dd เสมอ (กันปัญหา timezone)
function fmtD_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}
function fmtDate_(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function parseD_(s) {
  const p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

// ---------- ความปลอดภัย: PIN hash + token ----------

function secret_() { return PropertiesService.getScriptProperties().getProperty('SECRET'); }

function hashPin_(empId, pin) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, empId + ':' + pin + ':' + secret_());
  return raw.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function signToken_(payload, expMillis) {
  const body = payload + '|' + expMillis;
  const sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, secret_()));
  return Utilities.base64EncodeWebSafe(body) + '.' + sig;
}

/** คืนค่า payload (ตัด exp ออกแล้ว) หรือ throw ถ้าไม่ผ่าน */
function verifyToken_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('token ไม่ถูกต้อง');
  const body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  const expect = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_()));
  if (expect !== parts[1]) throw new Error('token ไม่ถูกต้อง');
  const idx = body.lastIndexOf('|');
  const exp = Number(body.slice(idx + 1));
  if (Date.now() > exp) throw new Error('หมดเวลาใช้งาน กรุณา login ใหม่');
  return body.slice(0, idx);
}

function auth_(token) {
  const payload = verifyToken_(token); // 'auth|EMPxxx'
  const parts = payload.split('|');
  if (parts[0] !== 'auth') throw new Error('token ไม่ถูกต้อง');
  const emp = findEmp_(parts[1]);
  if (!emp) throw new Error('ไม่พบผู้ใช้');
  return emp;
}
