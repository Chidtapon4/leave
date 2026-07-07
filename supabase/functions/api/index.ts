// ระบบแจ้งลางาน — backend บน Supabase Edge Function (แทน Google Apps Script)
// พูด API protocol เดียวกับ Code.gs เดิมทุกประการ หน้าเว็บแก้แค่ API_URL ใน config.js
//
// ติดตั้ง: ดู MIGRATE-SUPABASE.md
// Secrets ที่ต้องตั้ง: APP_SECRET (บังคับ), BREVO_API_KEY + SENDER_EMAIL (ถ้าต้องการอีเมลแจ้งเตือน)

import { createClient } from 'npm:@supabase/supabase-js@2';

const supa = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const SECRET = Deno.env.get('APP_SECRET') ?? '';
const TOKEN_HOURS = 12;       // อายุ token หลัง login
const DECIDE_LINK_DAYS = 7;   // อายุลิงก์อนุมัติในอีเมล

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!SECRET) return json({ ok: false, error: 'ยังไม่ได้ตั้งค่า APP_SECRET (ดู MIGRATE-SUPABASE.md)' });

  if (req.method === 'GET') return handleGet(new URL(req.url));

  try {
    const body = await req.json();
    const handlers: Record<string, (b: any) => Promise<unknown>> = {
      bootstrap: apiBootstrap,
      login: apiLogin,
      me: apiMe,
      submit: apiSubmit,
      updateRequest: apiUpdateRequest,
      myRequests: apiMyRequests,
      cancel: apiCancel,
      changePin: apiChangePin,
      pending: apiPending,
      decide: apiDecide,
      dashboard: apiDashboard,
      report: apiReport,
      addEmployee: apiAddEmployee,
      employees: apiEmployees,
      updateEmployee: apiUpdateEmployee,
    };
    const fn = handlers[body.action];
    if (!fn) throw new Error('ไม่รู้จักคำสั่ง: ' + body.action);
    return json(await fn(body));
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});

// ---------- GET: health check + ลิงก์อนุมัติจากอีเมล ----------
// เปิดลิงก์ = เจอหน้ายืนยันก่อนเสมอ สถานะเปลี่ยนเมื่อกดปุ่มยืนยัน (JavaScript) เท่านั้น
// กันระบบสแกนอีเมล (SafeLinks/แอนติไวรัส) เปิดลิงก์แล้วอนุมัติแทนคน

async function handleGet(url: URL): Promise<Response> {
  const p = url.searchParams;
  if (p.get('action') === 'decide') {
    try {
      const payload = await verifyToken(p.get('t') ?? ''); // 'decide|reqId|approverId'
      const parts = payload.split('|');
      if (parts[0] !== 'decide' || parts[1] !== p.get('r')) throw new Error('ลิงก์ไม่ถูกต้อง');
      const decision = p.get('d') === 'approved' ? 'approved' : 'rejected';
      const reqRow = await getRequest(parts[1]);
      if (!reqRow) throw new Error('ไม่พบใบลา');
      if (reqRow.status !== 'pending') {
        return page(`ℹ️ ใบลานี้ถูกดำเนินการไปแล้ว (สถานะ: ${statusTh(reqRow.status)})`);
      }
      if (p.get('confirm') !== '1') return confirmPage(reqRow, decision, p);
      await decide(parts[1], decision, parts[2], '');
      return page(decision === 'approved' ? '✅ อนุมัติใบลาเรียบร้อยแล้ว' : '❌ บันทึกไม่อนุมัติเรียบร้อยแล้ว');
    } catch (err) {
      return page('⚠️ ' + String((err as Error)?.message ?? err));
    }
  }
  return json({ ok: true, service: 'leave-system', backend: 'supabase' });
}

// ---------- bootstrap: สร้าง admin คนแรก (ทำได้เฉพาะตอนตารางพนักงานว่าง) ----------

async function apiBootstrap(b: any) {
  const { count } = await supa.from('employees').select('emp_id', { count: 'exact', head: true });
  if ((count ?? 0) > 0) throw new Error('ระบบมีพนักงานแล้ว ใช้แท็บ "พนักงาน" ในเว็บแทน');
  const id = String(b.emp_id ?? 'EMP999').trim().toUpperCase();
  const pin = String(b.pin ?? '');
  if (!/^[A-Z0-9\-_.]{2,20}$/.test(id)) throw new Error('รหัสพนักงานต้องเป็น A-Z หรือตัวเลข 2-20 ตัว');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN ต้องเป็นตัวเลข 4-8 หลัก');
  const { error } = await supa.from('employees').insert({
    emp_id: id, name: String(b.name ?? 'Admin').trim() || 'Admin',
    email: String(b.email ?? '').trim(), pin_hash: await hashPin(id, pin), role: 'admin',
  });
  if (error) throw new Error(error.message);
  return { ok: true, emp_id: id, note: 'สร้าง admin คนแรกแล้ว login ได้เลย' };
}

// ---------- ผู้ใช้ ----------

async function apiLogin(b: any) {
  const empId = String(b.emp_id ?? '').trim().toUpperCase();
  const emp = await getEmp(empId);
  if (!emp || emp.pin_hash !== await hashPin(empId, String(b.pin ?? ''))) {
    throw new Error('รหัสพนักงานหรือ PIN ไม่ถูกต้อง');
  }
  const token = await signToken('auth|' + emp.emp_id, Date.now() + TOKEN_HOURS * 3600 * 1000);
  return bundle(emp, token);
}

async function apiMe(b: any) {
  const emp = await auth(b.token);
  return bundle(emp, b.token);
}

async function bundle(emp: any, token: string) {
  const manager = emp.manager_id ? await getEmp(emp.manager_id) : null;
  return {
    ok: true,
    token,
    profile: {
      emp_id: emp.emp_id, name: emp.name, dept: emp.dept, role: emp.role,
      email: emp.email ?? '', phone: emp.phone ?? '',
      manager_id: emp.manager_id ?? '', manager_name: manager?.name ?? '',
    },
    types: await getTypes(),
    holidays: await getHolidays(),
    balances: await balances(emp.emp_id),
    work_all_week: await workAllWeek(),
  };
}

// ---------- ยื่นลา ----------

async function apiSubmit(b: any) {
  const emp = await auth(b.token);
  const types = await getTypes();
  const type = types.find((t) => t.type_id === b.type_id);
  if (!type) throw new Error('ประเภทการลาไม่ถูกต้อง');

  const start = String(b.start ?? '');
  const end = String(b.end ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  if (end < start) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  const halfDay = !!b.half_day;
  if (halfDay && start !== end) throw new Error('ลาครึ่งวันได้เมื่อเลือกวันเดียวเท่านั้น');

  const holidays = new Set(await getHolidays());
  const days = countDays(start, end, halfDay, holidays, await workAllWeek());
  if (days <= 0) throw new Error('ช่วงที่เลือกไม่มีวันทำการ (ตรงวันหยุดทั้งหมด)');

  // เช็กโควตา (นับทั้งอนุมัติแล้วและรออนุมัติ กันยื่นเกินสิทธิ์)
  if (type.quota_days !== null) {
    const bal = (await balances(emp.emp_id)).find((x) => x.type_id === type.type_id)!;
    if (bal.quota !== null && bal.used + bal.pending + days > bal.quota) {
      throw new Error(`วันลาคงเหลือไม่พอ (${type.name} เหลือ ${bal.quota - bal.used - bal.pending} วัน)`);
    }
  }

  // อัปโหลดไฟล์แนบ (ใบรับรองแพทย์) ขึ้น Supabase Storage
  let fileUrl = '';
  if (b.file?.data) {
    const bin = Uint8Array.from(atob(b.file.data), (c) => c.charCodeAt(0));
    const safeName = String(b.file.name ?? 'attachment').replace(/[^\w.\-ก-๙]+/g, '_');
    const path = `${emp.emp_id}/${Date.now()}_${safeName}`;
    const { error } = await supa.storage.from('attachments')
      .upload(path, bin, { contentType: b.file.mime || 'application/octet-stream' });
    if (error) throw new Error('อัปโหลดไฟล์ไม่สำเร็จ: ' + error.message);
    fileUrl = supa.storage.from('attachments').getPublicUrl(path).data.publicUrl;
  }

  const reqId = `REQ-${bkkStamp()}-${emp.emp_id}`;
  const { error } = await supa.from('leave_requests').insert({
    req_id: reqId, emp_id: emp.emp_id, type_id: type.type_id,
    start_date: start, end_date: end, half_day: halfDay, days,
    reason: String(b.reason ?? ''), file_url: fileUrl, status: 'pending',
  });
  if (error) throw new Error(error.message);

  await notifyManager(emp, { req_id: reqId, type_name: type.name, start, end, days, reason: b.reason, file_url: fileUrl });
  return { ok: true, req_id: reqId, days };
}

async function apiMyRequests(b: any) {
  const emp = await auth(b.token);
  const { data, error } = await supa.from('leave_requests').select('*')
    .eq('emp_id', emp.emp_id).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return { ok: true, requests: (data ?? []).map(numify) };
}

// ยกเลิกได้: ใบที่รออนุมัติ หรือใบที่อนุมัติแล้วแต่ยังไม่ถึงวันเริ่มลา (คืนวันลา + แจ้งหัวหน้า)
async function apiCancel(b: any) {
  const emp = await auth(b.token);
  const row = await getRequest(String(b.req_id ?? ''));
  if (!row || row.emp_id !== emp.emp_id) throw new Error('ไม่พบใบลา');
  const canCancel = row.status === 'pending' ||
    (row.status === 'approved' && row.start_date > todayBkk());
  if (!canCancel) throw new Error('ยกเลิกได้เฉพาะใบลาที่รออนุมัติ หรืออนุมัติแล้วที่ยังไม่ถึงวันเริ่มลา');
  const { data, error } = await supa.from('leave_requests')
    .update({ status: 'cancelled', decided_at: new Date().toISOString() })
    .eq('req_id', row.req_id).eq('status', row.status).select('req_id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('ใบลานี้ถูกดำเนินการไปแล้ว ลองรีเฟรชหน้า');
  if (row.status === 'approved') await notifyManagerCancelled(emp, row);
  return { ok: true };
}

// แก้ไขใบลา (เฉพาะที่ยังรออนุมัติ) — กรณีลาผิดวัน
async function apiUpdateRequest(b: any) {
  const emp = await auth(b.token);
  const row = await getRequest(String(b.req_id ?? ''));
  if (!row || row.emp_id !== emp.emp_id) throw new Error('ไม่พบใบลา');
  if (row.status !== 'pending') throw new Error('แก้ไขได้เฉพาะใบลาที่รออนุมัติ — ใบที่อนุมัติแล้วให้ยกเลิกแล้วยื่นใหม่');

  const types = await getTypes();
  const type = types.find((t) => t.type_id === b.type_id);
  if (!type) throw new Error('ประเภทการลาไม่ถูกต้อง');
  const start = String(b.start ?? '');
  const end = String(b.end ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  if (end < start) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  const halfDay = !!b.half_day;
  if (halfDay && start !== end) throw new Error('ลาครึ่งวันได้เมื่อเลือกวันเดียวเท่านั้น');

  const holidays = new Set(await getHolidays());
  const days = countDays(start, end, halfDay, holidays, await workAllWeek());
  if (days <= 0) throw new Error('ช่วงที่เลือกไม่มีวันทำการ (ตรงวันหยุดทั้งหมด)');

  // เช็กโควตาโดยไม่นับวันของใบเดิมซ้ำ
  if (type.quota_days !== null) {
    const bal = (await balances(emp.emp_id)).find((x) => x.type_id === type.type_id)!;
    const oldSameType = row.type_id === type.type_id ? row.days : 0;
    if (bal.quota !== null && bal.used + bal.pending - oldSameType + days > bal.quota) {
      throw new Error(`วันลาคงเหลือไม่พอ (${type.name} เหลือ ${bal.quota - bal.used - bal.pending + oldSameType} วัน)`);
    }
  }

  // แนบไฟล์ใหม่ = แทนที่ไฟล์เดิม / ไม่แนบ = คงไฟล์เดิม
  let fileUrl = row.file_url ?? '';
  if (b.file?.data) {
    const bin = Uint8Array.from(atob(b.file.data), (c) => c.charCodeAt(0));
    const safeName = String(b.file.name ?? 'attachment').replace(/[^\w.\-ก-๙]+/g, '_');
    const path = `${emp.emp_id}/${Date.now()}_${safeName}`;
    const { error } = await supa.storage.from('attachments')
      .upload(path, bin, { contentType: b.file.mime || 'application/octet-stream' });
    if (error) throw new Error('อัปโหลดไฟล์ไม่สำเร็จ: ' + error.message);
    fileUrl = supa.storage.from('attachments').getPublicUrl(path).data.publicUrl;
  }

  const { data, error } = await supa.from('leave_requests')
    .update({ type_id: type.type_id, start_date: start, end_date: end, half_day: halfDay, days, reason: String(b.reason ?? ''), file_url: fileUrl })
    .eq('req_id', row.req_id).eq('status', 'pending').select('req_id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('ใบลานี้ถูกดำเนินการไปแล้ว ลองรีเฟรชหน้า');

  await notifyManager(emp, { req_id: row.req_id, type_name: type.name, start, end, days, reason: b.reason, file_url: fileUrl, edited: true });
  return { ok: true, days };
}

// พนักงานเปลี่ยน PIN ของตัวเอง (ต้องรู้ PIN เดิม)
async function apiChangePin(b: any) {
  const emp = await auth(b.token);
  if (emp.pin_hash !== await hashPin(emp.emp_id, String(b.old_pin ?? ''))) throw new Error('PIN เดิมไม่ถูกต้อง');
  const pin = String(b.new_pin ?? '');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN ใหม่ต้องเป็นตัวเลข 4-8 หลัก');
  const { error } = await supa.from('employees')
    .update({ pin_hash: await hashPin(emp.emp_id, pin) }).eq('emp_id', emp.emp_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ---------- อนุมัติ ----------

async function apiPending(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['approver', 'admin']);
  const { data, error } = await supa.from('leave_requests')
    .select('*, employees!leave_requests_emp_id_fkey(name, manager_id)')
    .eq('status', 'pending').order('created_at');
  if (error) throw new Error(error.message);
  const list = (data ?? [])
    .filter((r: any) => emp.role === 'admin' || r.employees?.manager_id === emp.emp_id)
    .map((r: any) => numify({ ...r, emp_name: r.employees?.name ?? r.emp_id, employees: undefined }));
  return { ok: true, requests: list };
}

async function apiDecide(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['approver', 'admin']);
  const row = await getRequest(String(b.req_id ?? ''));
  if (!row) throw new Error('ไม่พบใบลา');
  if (emp.role !== 'admin') {
    const owner = await getEmp(row.emp_id);
    if (!owner || owner.manager_id !== emp.emp_id) throw new Error('ไม่มีสิทธิ์อนุมัติใบลานี้');
  }
  const decision = b.decision === 'approved' ? 'approved' : 'rejected';
  await decide(row.req_id, decision, emp.emp_id, String(b.comment ?? ''));
  return { ok: true };
}

async function decide(reqId: string, decision: string, approverId: string, comment: string) {
  const row = await getRequest(reqId);
  if (!row) throw new Error('ไม่พบใบลา ' + reqId);
  if (row.status !== 'pending') throw new Error(`ใบลานี้ถูกดำเนินการไปแล้ว (สถานะ: ${statusTh(row.status)})`);
  // เงื่อนไข eq('status','pending') กันสองคนกดตัดสินพร้อมกัน — คนแรกชนะ
  const { data, error } = await supa.from('leave_requests')
    .update({ status: decision, approver_id: approverId, decided_at: new Date().toISOString(), comment })
    .eq('req_id', reqId).eq('status', 'pending').select('req_id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('ใบลานี้ถูกดำเนินการไปแล้ว');
  await notifyEmployee(row, decision, comment);
}

// ---------- dashboard (HR/admin) ----------

async function apiDashboard(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['admin']);

  const today = todayBkk();
  const year = today.slice(0, 4);
  const types = await getTypes();
  const settings = await getSettings();

  // ช่วงกราฟรายเดือน: 6 เดือนล่าสุดรวมเดือนนี้
  const now = new Date(today + 'T00:00:00Z');
  const from6 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);

  const [emps, pendingRows, yearRows, sixMonthRows, holRows, quotaRows] = await Promise.all([
    supa.from('employees').select('*').order('emp_id'),
    supa.from('leave_requests').select('req_id,emp_id,created_at,start_date, employees!leave_requests_emp_id_fkey(name, manager_id)').eq('status', 'pending'),
    supa.from('leave_requests')
      .select('*, employees!leave_requests_emp_id_fkey(name)')
      .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`),
    supa.from('leave_requests').select('start_date,days,status').gte('start_date', from6),
    supa.from('holidays').select('date,name').gte('date', today).order('date').limit(1),
    supa.from('quotas').select('*'),
  ]);
  if (emps.error) throw new Error(emps.error.message);
  if (yearRows.error) throw new Error(yearRows.error.message);

  const empList = emps.data ?? [];
  const empById: Record<string, any> = {};
  for (const e of empList) empById[e.emp_id] = e;

  const thisYear = (yearRows.data ?? []).map((r: any) => numify({ ...r, emp_name: r.employees?.name ?? r.emp_id, employees: undefined }));
  const approved = thisYear.filter((r: any) => r.status === 'approved');
  const active = thisYear.filter((r: any) => r.status === 'approved' || r.status === 'pending');

  // ใบลาค้างนานเกินกำหนด
  const aging = (pendingRows.data ?? [])
    .map((r: any) => ({
      req_id: r.req_id,
      emp_name: r.employees?.name ?? r.emp_id,
      approver_name: empById[r.employees?.manager_id]?.name ?? '',
      start_date: fmtDateOnly(r.start_date),
      waiting_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
    }))
    .filter((r: any) => r.waiting_days >= settings.pendingDays)
    .sort((a: any, b: any) => b.waiting_days - a.waiting_days);

  // วันที่คนลาพร้อมกันเยอะใน 30 วันข้างหน้า
  const holidaySet = new Set(await getHolidays());
  const limit30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const dayMap: Record<string, Set<string>> = {};
  for (const r of active) {
    const d = new Date((r.start_date > today ? r.start_date : today) + 'T00:00:00Z');
    const end = new Date((r.end_date < limit30 ? r.end_date : limit30) + 'T00:00:00Z');
    while (d <= end) {
      const ds = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      if (settings.workAllWeek || (dow !== 0 && dow !== 6 && !holidaySet.has(ds))) {
        (dayMap[ds] = dayMap[ds] ?? new Set()).add(r.emp_name);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  const clashes = Object.keys(dayMap)
    .filter((ds) => dayMap[ds].size >= settings.clashPeople)
    .sort()
    .slice(0, 3)
    .map((ds) => ({ date: ds, count: dayMap[ds].size, names: [...dayMap[ds]] }));

  // วันลารายเดือน 6 เดือนล่าสุด (นับจากเดือนของวันเริ่มลา เฉพาะที่อนุมัติ)
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const ym = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    const days = (sixMonthRows.data ?? [])
      .filter((r: any) => r.status === 'approved' && String(r.start_date).slice(0, 7) === ym)
      .reduce((s: number, r: any) => s + Number(r.days), 0);
    monthly.push({ ym, days });
  }

  // % การใช้สิทธิ์รวมทั้งบริษัท (เฉพาะประเภทที่มีโควตา)
  const overrides: Record<string, Record<string, number>> = {};
  for (const q of quotaRows.data ?? []) {
    (overrides[String(q.emp_id).trim()] = overrides[String(q.emp_id).trim()] ?? {})[q.type_id] = Number(q.quota_days);
  }
  const quotaTypeIds = new Set(types.filter((t) => t.quota_days !== null).map((t) => t.type_id));
  let totalQuota = 0;
  for (const e of empList) {
    for (const t of types) {
      if (t.quota_days === null && !(overrides[e.emp_id]?.[t.type_id] !== undefined)) continue;
      totalQuota += overrides[e.emp_id]?.[t.type_id] ?? Number(t.quota_days ?? 0);
    }
  }
  const usedQuota = approved.filter((r: any) => quotaTypeIds.has(r.type_id)).reduce((s: number, r: any) => s + r.days, 0);

  const employees = [];
  for (const e of empList) {
    employees.push({ emp_id: e.emp_id, name: e.name, dept: e.dept, balances: await balances(e.emp_id) });
  }

  const nh = holRows.data?.[0];

  return {
    ok: true,
    types,
    stats: {
      pending: (pendingRows.data ?? []).length,
      onLeaveToday: approved.filter((r: any) => r.start_date <= today && today <= r.end_date).map((r: any) => r.emp_name),
      usedTotal: approved.reduce((s: number, r: any) => s + r.days, 0),
    },
    used_percent: totalQuota > 0 ? Math.round(usedQuota / totalQuota * 100) : null,
    aging,
    clashes,
    monthly,
    next_holiday: nh
      ? { date: fmtDateOnly(nh.date), name: nh.name, days_until: Math.round((new Date(fmtDateOnly(nh.date) + 'T00:00:00Z').getTime() - now.getTime()) / 86400000) }
      : null,
    alert_settings: { pending_days: settings.pendingDays, clash_people: settings.clashPeople },
    employees,
    leaves: thisYear
      .filter((r: any) => r.status === 'approved' || r.status === 'pending')
      .map((r: any) => ({ emp_name: r.emp_name, type_id: r.type_id, start_date: r.start_date, end_date: r.end_date, status: r.status, days: r.days })),
  };
}

// รายงานใบลาทั้งปีสำหรับ export CSV (admin)
async function apiReport(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['admin']);
  const year = /^\d{4}$/.test(String(b.year ?? '')) ? String(b.year) : todayBkk().slice(0, 4);
  const { data, error } = await supa.from('leave_requests')
    .select('*, employees!leave_requests_emp_id_fkey(name)')
    .gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`)
    .order('start_date');
  if (error) throw new Error(error.message);
  return {
    ok: true,
    year,
    rows: (data ?? []).map((r: any) => ({
      req_id: r.req_id, emp_id: r.emp_id, emp_name: r.employees?.name ?? r.emp_id,
      type_id: r.type_id, start_date: r.start_date, end_date: r.end_date,
      days: Number(r.days), status: r.status, approver_id: r.approver_id ?? '',
      created_at: String(r.created_at).slice(0, 10), reason: r.reason ?? '',
    })),
  };
}

function fmtDateOnly(v: unknown): string {
  return String(v).slice(0, 10);
}

// ---------- จัดการพนักงาน (HR/admin) ----------

async function apiEmployees(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['admin']);
  const [emps, quotas] = await Promise.all([
    supa.from('employees').select('emp_id,name,dept,email,phone,role,manager_id').order('emp_id'),
    supa.from('quotas').select('*'),
  ]);
  if (emps.error) throw new Error(emps.error.message);
  const overrides: Record<string, Record<string, number>> = {};
  for (const q of quotas.data ?? []) {
    (overrides[q.emp_id] = overrides[q.emp_id] ?? {})[q.type_id] = Number(q.quota_days);
  }
  return {
    ok: true,
    types: await getTypes(),
    employees: (emps.data ?? []).map((e: any) => ({ ...e, manager_id: e.manager_id ?? '', quotas: overrides[e.emp_id] ?? {} })),
  };
}

async function apiAddEmployee(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['admin']);
  const v = await validateEmpInput(b, { requirePin: true });
  const { error } = await supa.from('employees').insert({
    emp_id: v.id, name: v.name, dept: v.dept, email: v.email, phone: v.phone,
    pin_hash: await hashPin(v.id, v.pin), role: v.role, manager_id: v.managerId || null,
  });
  if (error) {
    if (error.code === '23505') throw new Error('มีรหัสพนักงาน ' + v.id + ' อยู่แล้ว');
    throw new Error(error.message);
  }
  await saveQuotas(v.id, b.quotas);
  return { ok: true, emp_id: v.id };
}

async function apiUpdateEmployee(b: any) {
  const emp = await auth(b.token);
  requireRole(emp, ['admin']);
  const v = await validateEmpInput(b, { requirePin: false });
  if (v.id === emp.emp_id && v.role !== 'admin') throw new Error('ลดสิทธิ์บัญชีของตัวเองไม่ได้ (กันระบบไม่มี admin)');
  if (v.managerId === v.id) throw new Error('ตั้งตัวเองเป็นหัวหน้าของตัวเองไม่ได้');
  if (!await getEmp(v.id)) throw new Error('ไม่พบพนักงาน ' + v.id);

  const values: Record<string, unknown> = { name: v.name, dept: v.dept, email: v.email, phone: v.phone, role: v.role, manager_id: v.managerId || null };
  if (v.pin) values.pin_hash = await hashPin(v.id, v.pin);
  const { error } = await supa.from('employees').update(values).eq('emp_id', v.id);
  if (error) throw new Error(error.message);
  await saveQuotas(v.id, b.quotas);
  return { ok: true, emp_id: v.id };
}

async function validateEmpInput(b: any, opt: { requirePin: boolean }) {
  const id = String(b.emp_id ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9\-_.]{2,20}$/.test(id)) throw new Error('รหัสพนักงานต้องเป็น A-Z หรือตัวเลข 2-20 ตัว');
  const name = String(b.name ?? '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อ-สกุล');
  const pin = String(b.pin ?? '');
  if ((opt.requirePin || pin) && !/^\d{4,8}$/.test(pin)) throw new Error('PIN ต้องเป็นตัวเลข 4-8 หลัก');
  const role = ['employee', 'approver', 'admin'].includes(b.role) ? b.role : 'employee';
  const managerId = String(b.manager_id ?? '').trim().toUpperCase();
  if (managerId && !await getEmp(managerId)) throw new Error('ไม่พบรหัสหัวหน้า ' + managerId);
  const email = String(b.email ?? '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');
  const phone = String(b.phone ?? '').trim();
  if (phone && !/^[0-9+\-\s()]{5,20}$/.test(phone)) throw new Error('รูปแบบเบอร์โทรไม่ถูกต้อง');
  return { id, name, pin, role, managerId, email, phone, dept: String(b.dept ?? '').trim() };
}

// สิทธิ์รายคน: ค่าว่าง = ล้าง override กลับไปใช้ค่ามาตรฐาน
async function saveQuotas(empId: string, quotas: Record<string, string> | undefined) {
  if (!quotas) return;
  for (const typeId of Object.keys(quotas)) {
    const raw = String(quotas[typeId]).trim();
    if (raw === '') {
      await supa.from('quotas').delete().eq('emp_id', empId).eq('type_id', typeId);
    } else {
      const n = Number(raw);
      if (isNaN(n) || n < 0) throw new Error('สิทธิ์วันลาต้องเป็นตัวเลข 0 ขึ้นไป');
      const { error } = await supa.from('quotas').upsert({ emp_id: empId, type_id: typeId, quota_days: n });
      if (error) throw new Error(error.message);
    }
  }
}

// ---------- นับวันลา + วันลาคงเหลือ ----------

function countDays(start: string, end: string, halfDay: boolean, holidays: Set<string>, allWeek: boolean): number {
  let n = 0;
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d <= e) {
    const dow = d.getUTCDay();
    const ds = d.toISOString().slice(0, 10);
    if (allWeek || (dow !== 0 && dow !== 6 && !holidays.has(ds))) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (halfDay && n === 1) n = 0.5;
  return n;
}

async function balances(empId: string) {
  const year = todayBkk().slice(0, 4);
  const [reqs, quotas, types] = await Promise.all([
    supa.from('leave_requests').select('type_id,days,status')
      .eq('emp_id', empId).gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`),
    supa.from('quotas').select('type_id,quota_days').eq('emp_id', empId),
    getTypes(),
  ]);
  const mine = (reqs.data ?? []).map((r: any) => ({ ...r, days: Number(r.days) }));
  const overrides: Record<string, number> = {};
  for (const q of quotas.data ?? []) overrides[q.type_id] = Number(q.quota_days);

  return types.map((t) => {
    const used = mine.filter((r) => r.type_id === t.type_id && r.status === 'approved').reduce((s, r) => s + r.days, 0);
    const pending = mine.filter((r) => r.type_id === t.type_id && r.status === 'pending').reduce((s, r) => s + r.days, 0);
    const quota = t.type_id in overrides ? overrides[t.type_id] : t.quota_days;
    return { type_id: t.type_id, name: t.name, quota, used, pending, remaining: quota === null ? null : quota - used - pending };
  });
}

// ---------- อีเมลแจ้งเตือน (Brevo — ไม่ตั้งค่าก็ข้ามไปเฉย ๆ ระบบยังใช้ได้) ----------

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get('BREVO_API_KEY');
  const sender = Deno.env.get('SENDER_EMAIL');
  if (!key || !sender || !to) return;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: sender, name: 'ระบบแจ้งลางาน' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
  } catch { /* อีเมลล้มเหลวไม่ควรทำให้ใบลาล้มไปด้วย */ }
}

function apiUrl(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/api`;
}

async function notifyManager(emp: any, info: any) {
  if (!emp.manager_id) return;
  const manager = await getEmp(emp.manager_id);
  if (!manager?.email) return;
  const exp = Date.now() + DECIDE_LINK_DAYS * 86400 * 1000;
  const t = await signToken(`decide|${info.req_id}|${manager.emp_id}`, exp);
  const link = (d: string) => `${apiUrl()}?action=decide&r=${encodeURIComponent(info.req_id)}&d=${d}&t=${encodeURIComponent(t)}`;
  const btn = 'display:inline-block;padding:12px 28px;border-radius:8px;color:#fff;text-decoration:none;font-size:16px';
  await sendEmail(manager.email, `[${info.edited ? 'แก้ไขใบลา' : 'ใบลาใหม่'}] ${emp.name} — ${info.type_name} ${info.days} วัน`,
    `<div style="font-family:sans-serif;max-width:480px">
      <h2 style="margin:0 0 12px">${info.edited ? 'ใบลาถูกแก้ไข — รออนุมัติ' : 'ใบลารออนุมัติ'}</h2>
      <p><b>${esc(emp.name)}</b> (${esc(emp.emp_id)}) ขอ<b>${esc(info.type_name)}</b><br>
      วันที่ ${info.start} ถึง ${info.end} รวม <b>${info.days} วันทำการ</b><br>
      เหตุผล: ${esc(info.reason || '-')}
      ${info.file_url ? `<br>ไฟล์แนบ: <a href="${esc(info.file_url)}">เปิดดู</a>` : ''}</p>
      <p style="margin:24px 0">
      <a href="${link('approved')}" style="${btn};background:#0F6E56">✓ อนุมัติ</a>&nbsp;&nbsp;
      <a href="${link('rejected')}" style="${btn};background:#A32D2D">✕ ไม่อนุมัติ</a></p>
      <p style="color:#888;font-size:13px">กดปุ่มแล้วยืนยันอีกครั้งในหน้าที่เปิดขึ้น (ไม่ต้อง login) หรือเข้าไปจัดการในเว็บที่แท็บ "อนุมัติ"</p></div>`);
}

async function notifyManagerCancelled(emp: any, row: any) {
  if (!emp.manager_id) return;
  const manager = await getEmp(emp.manager_id);
  if (!manager?.email) return;
  await sendEmail(manager.email, `[ยกเลิกใบลา] ${emp.name} — ${row.start_date} ถึง ${row.end_date}`,
    `<div style="font-family:sans-serif;max-width:480px">
      <h2 style="margin:0 0 12px">ใบลาที่อนุมัติแล้วถูกยกเลิก</h2>
      <p><b>${esc(emp.name)}</b> (${esc(emp.emp_id)}) ยกเลิกใบลาวันที่ ${row.start_date} ถึง ${row.end_date}
      (${row.days} วัน) — ระบบคืนวันลาให้แล้ว ไม่ต้องดำเนินการใด ๆ</p></div>`);
}

async function notifyEmployee(reqRow: any, decision: string, comment: string) {
  const emp = await getEmp(reqRow.emp_id);
  if (!emp?.email) return;
  const approved = decision === 'approved';
  await sendEmail(emp.email,
    `[ผลใบลา] ${approved ? 'อนุมัติแล้ว ✓' : 'ไม่อนุมัติ ✕'} — ${reqRow.start_date} ถึง ${reqRow.end_date}`,
    `<div style="font-family:sans-serif;max-width:480px">
      <h2 style="margin:0 0 12px;color:${approved ? '#0F6E56' : '#A32D2D'}">${approved ? 'ใบลาได้รับการอนุมัติ' : 'ใบลาไม่ได้รับการอนุมัติ'}</h2>
      <p>ใบลาวันที่ ${reqRow.start_date} ถึง ${reqRow.end_date} (${reqRow.days} วัน)
      ${comment ? '<br>หมายเหตุจากผู้อนุมัติ: ' + esc(comment) : ''}</p></div>`);
}

// ---------- หน้า HTML สำหรับลิงก์อนุมัติ ----------

function page(msg: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <div style="font-family:sans-serif;text-align:center;padding:48px 16px;font-size:20px">${msg}
    <br><br><span style="font-size:14px;color:#666">ปิดหน้านี้ได้เลย</span></div>`,
    { headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' } },
  );
}

async function confirmPage(reqRow: any, decision: string, p: URLSearchParams): Promise<Response> {
  const types = await getTypes();
  const type = types.find((t) => t.type_id === reqRow.type_id);
  const owner = await getEmp(reqRow.emp_id);
  const approve = decision === 'approved';
  const color = approve ? '#0F6E56' : '#A32D2D';
  const url = `${apiUrl()}?action=decide&r=${encodeURIComponent(p.get('r') ?? '')}&d=${decision}&t=${encodeURIComponent(p.get('t') ?? '')}&confirm=1`;
  return new Response(
    `<!DOCTYPE html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <div style="font-family:sans-serif;max-width:420px;margin:32px auto;padding:0 16px;text-align:center">
    <h2 style="color:${color}">${approve ? 'ยืนยันการอนุมัติใบลา' : 'ยืนยันการไม่อนุมัติใบลา'}</h2>
    <div style="background:#F5F6F4;border-radius:12px;padding:16px;text-align:left;line-height:1.9">
    <b>${esc(owner?.name ?? reqRow.emp_id)}</b> (${esc(reqRow.emp_id)})<br>
    ${esc(type?.name ?? reqRow.type_id)} รวม <b>${reqRow.days} วันทำการ</b><br>
    วันที่ ${reqRow.start_date} ถึง ${reqRow.end_date}<br>
    เหตุผล: ${esc(reqRow.reason || '-')}
    ${reqRow.file_url ? `<br><a href="${esc(reqRow.file_url)}" target="_blank">📎 เปิดไฟล์แนบ</a>` : ''}</div>
    <button onclick="this.disabled=true;this.textContent='กำลังบันทึก…';location.href='${url}'"
    style="margin-top:24px;padding:14px 40px;font-size:17px;border:none;border-radius:8px;cursor:pointer;color:#fff;background:${color}">
    ${approve ? '✓ ยืนยันอนุมัติ' : '✕ ยืนยันไม่อนุมัติ'}</button>
    <p style="color:#888;font-size:13px;margin-top:16px">ถ้ากดผิดปุ่มจากอีเมล ปิดหน้านี้ได้เลย จะยังไม่มีอะไรถูกบันทึก</p></div>`,
    { headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' } },
  );
}

// ---------- ตัวช่วยอ่านข้อมูล ----------

async function getEmp(empId: string) {
  const { data } = await supa.from('employees').select('*').eq('emp_id', empId).maybeSingle();
  return data;
}

async function getRequest(reqId: string) {
  const { data } = await supa.from('leave_requests').select('*').eq('req_id', reqId).maybeSingle();
  return data ? numify(data) : null;
}

async function getTypes() {
  const { data, error } = await supa.from('leave_types').select('*').order('sort');
  if (error) throw new Error(error.message);
  return (data ?? []).map((t: any) => ({ ...t, quota_days: t.quota_days === null ? null : Number(t.quota_days) }));
}

async function getHolidays(): Promise<string[]> {
  const { data } = await supa.from('holidays').select('date');
  return (data ?? []).map((h: any) => String(h.date));
}

async function workAllWeek(): Promise<boolean> {
  return (await getSettings()).workAllWeek;
}

// ค่าตั้งระบบทั้งหมด (แถวไหนไม่มีในตาราง settings ใช้ค่าเริ่มต้น)
async function getSettings() {
  const { data } = await supa.from('settings').select('*');
  const m: Record<string, string> = {};
  for (const r of data ?? []) m[r.key] = String(r.value);
  return {
    workAllWeek: m['work_all_week'] !== 'false',
    pendingDays: Number(m['alert_pending_days'] ?? 3),   // ใบลาค้างกี่วันถึงเตือน
    clashPeople: Number(m['alert_clash_people'] ?? 3),   // ลาพร้อมกันกี่คนถึงเตือน
  };
}

// numeric ของ Postgres มาเป็น string — แปลงเป็นตัวเลขให้หน้าเว็บ
function numify(r: any) {
  if (r.days !== undefined) r.days = Number(r.days);
  return r;
}

function requireRole(emp: any, roles: string[]) {
  if (!roles.includes(emp.role)) throw new Error('ไม่มีสิทธิ์ใช้งานส่วนนี้');
}

function statusTh(s: string): string {
  return ({ pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' } as Record<string, string>)[s] ?? s;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { ...CORS, 'content-type': 'application/json' } });
}

// เวลาไทย (UTC+7)
function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function bkkStamp(): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000).toISOString(); // 2026-07-06T14:30:59.xxx
  return d.slice(2, 10).replace(/-/g, '') + '-' + d.slice(11, 19).replace(/:/g, '');
}

// ---------- ความปลอดภัย: PIN hash + token (สูตรเดียวกับ Code.gs เดิม) ----------

const te = new TextEncoder();

async function hashPin(empId: string, pin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`${empId}:${pin}:${SECRET}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(msg))));
}

async function signToken(payload: string, expMillis: number): Promise<string> {
  const body = `${payload}|${expMillis}`;
  return `${b64u(te.encode(body))}.${await hmac(body)}`;
}

async function verifyToken(token: string): Promise<string> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2) throw new Error('token ไม่ถูกต้อง');
  const body = b64uDecode(parts[0]);
  if (await hmac(body) !== parts[1]) throw new Error('token ไม่ถูกต้อง');
  const i = body.lastIndexOf('|');
  if (Date.now() > Number(body.slice(i + 1))) throw new Error('หมดเวลาใช้งาน กรุณา login ใหม่');
  return body.slice(0, i);
}

async function auth(token: string) {
  const payload = await verifyToken(token); // 'auth|EMPxxx'
  const parts = payload.split('|');
  if (parts[0] !== 'auth') throw new Error('token ไม่ถูกต้อง');
  const emp = await getEmp(parts[1]);
  if (!emp) throw new Error('ไม่พบผู้ใช้');
  return emp;
}
