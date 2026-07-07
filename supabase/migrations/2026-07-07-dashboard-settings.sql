-- Migration: ค่าตั้งการเตือนบน dashboard (ไม่รันก็ได้ — โค้ดมีค่าเริ่มต้นให้อยู่แล้ว
-- รันไว้เพื่อให้เห็น/แก้ค่าได้ใน Table Editor)
-- วิธีใช้: Supabase Dashboard > SQL Editor > วางไฟล์นี้ > Run

insert into settings (key, value) values
  ('alert_pending_days', '3'),   -- ใบลาค้างเกินกี่วันให้เตือน
  ('alert_clash_people', '3')    -- ลาพร้อมกันกี่คนขึ้นไปให้เตือน
on conflict (key) do nothing;
