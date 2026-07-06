-- Migration: เพิ่มคอลัมน์เบอร์โทรพนักงาน
-- สำหรับฐานข้อมูลที่สร้างจาก schema.sql เวอร์ชันก่อน 2026-07-06
-- วิธีใช้: Supabase Dashboard > SQL Editor > วางไฟล์นี้ > Run

alter table employees add column if not exists phone text not null default '';
