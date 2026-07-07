-- ระบบแจ้งลางาน — โครงสร้างฐานข้อมูลบน Supabase (PostgreSQL)
-- วิธีใช้: เปิด Supabase Dashboard > SQL Editor > วางทั้งไฟล์นี้ > Run

-- ---------- ตาราง ----------

create table if not exists employees (
  emp_id     text primary key,
  name       text not null,
  dept       text not null default '',
  email      text not null default '',
  phone      text not null default '',
  pin_hash   text not null,
  role       text not null default 'employee' check (role in ('employee','approver','admin')),
  manager_id text references employees(emp_id),
  created_at timestamptz not null default now()
);

create table if not exists leave_types (
  type_id    text primary key,
  name       text not null,
  quota_days numeric,          -- null = ไม่จำกัด
  sort       int not null default 0
);

create table if not exists holidays (
  date date primary key,
  name text not null default ''
);

-- สิทธิ์วันลารายคน (override ค่ามาตรฐานใน leave_types)
create table if not exists quotas (
  emp_id     text not null references employees(emp_id) on delete cascade,
  type_id    text not null references leave_types(type_id) on delete cascade,
  quota_days numeric not null,
  primary key (emp_id, type_id)
);

create table if not exists leave_requests (
  req_id      text primary key,
  created_at  timestamptz not null default now(),
  emp_id      text not null references employees(emp_id),
  type_id     text not null references leave_types(type_id),
  start_date  date not null,
  end_date    date not null,
  half_day    boolean not null default false,
  days        numeric not null,
  reason      text not null default '',
  file_url    text not null default '',
  status      text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approver_id text,
  decided_at  timestamptz,
  comment     text not null default ''
);
create index if not exists leave_requests_emp_idx on leave_requests (emp_id);
create index if not exists leave_requests_status_idx on leave_requests (status);
create index if not exists leave_requests_start_idx on leave_requests (start_date);

create table if not exists settings (
  key   text primary key,
  value text not null
);

-- ---------- ความปลอดภัย ----------
-- เปิด RLS ทุกตารางโดยไม่สร้าง policy = ปิดการเข้าถึงจากภายนอกทั้งหมด
-- ข้อมูลเข้าออกได้ทางเดียวคือผ่าน Edge Function (ใช้ service role) เท่านั้น

alter table employees enable row level security;
alter table leave_types enable row level security;
alter table holidays enable row level security;
alter table quotas enable row level security;
alter table leave_requests enable row level security;
alter table settings enable row level security;

-- ---------- Storage bucket สำหรับไฟล์แนบ (ใบรับรองแพทย์) ----------

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- ---------- ข้อมูลเริ่มต้น ----------

insert into settings (key, value) values
  ('work_all_week', 'true'),        -- true = นับวันลาทุกวัน / false = ข้ามเสาร์-อาทิตย์+วันหยุด
  ('alert_pending_days', '3'),      -- ใบลาค้างเกินกี่วันให้เตือนใน dashboard
  ('alert_clash_people', '3')       -- ลาพร้อมกันกี่คนขึ้นไปให้เตือนใน dashboard
on conflict (key) do nothing;

insert into leave_types (type_id, name, quota_days, sort) values
  ('VAC',  'ลาพักร้อน', 6,  1),
  ('SICK', 'ลาป่วย',   30, 2),
  ('PER',  'ลากิจ',    3,  3),
  ('OTH',  'อื่น ๆ (ไม่จำกัด)', null, 4)
on conflict (type_id) do nothing;

insert into holidays (date, name) values
  ('2026-01-01', 'วันขึ้นปีใหม่'),
  ('2026-04-06', 'วันจักรี'),
  ('2026-04-13', 'วันสงกรานต์'),
  ('2026-04-14', 'วันสงกรานต์'),
  ('2026-04-15', 'วันสงกรานต์'),
  ('2026-05-01', 'วันแรงงาน'),
  ('2026-05-04', 'วันฉัตรมงคล'),
  ('2026-06-03', 'วันเฉลิมพระชนมพรรษาพระราชินี'),
  ('2026-07-28', 'วันเฉลิมพระชนมพรรษา ร.10'),
  ('2026-08-12', 'วันแม่แห่งชาติ'),
  ('2026-10-13', 'วันนวมินทรมหาราช'),
  ('2026-10-23', 'วันปิยมหาราช'),
  ('2026-12-05', 'วันพ่อแห่งชาติ'),
  ('2026-12-10', 'วันรัฐธรรมนูญ'),
  ('2026-12-31', 'วันสิ้นปี')
on conflict (date) do nothing;

-- หมายเหตุ: ไม่มีการ seed พนักงานที่นี่ เพราะ PIN hash ผูกกับ APP_SECRET ของแต่ละระบบ
-- ให้สร้างบัญชี admin คนแรกผ่านคำสั่ง bootstrap (ดู MIGRATE-SUPABASE.md ขั้นตอนที่ 5)
-- แล้วเพิ่มพนักงานที่เหลือผ่านแท็บ "พนักงาน" ในเว็บ
