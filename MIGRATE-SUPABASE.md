# คู่มือย้าย backend ไป Supabase (จังหวะสอง)

ย้ายจาก Google Sheets + Apps Script → Supabase (PostgreSQL + Edge Function + Storage)
หน้าเว็บบน Cloudflare **ไม่ต้องแก้อะไรเลย** ยกเว้นสลับ URL ใน `config.js` ตอนจบ

| ของเดิม | ของใหม่ |
|---|---|
| Google Sheets | ตาราง PostgreSQL ([supabase/schema.sql](supabase/schema.sql)) |
| Apps Script (Code.gs) | Edge Function ([supabase/functions/api/index.ts](supabase/functions/api/index.ts)) |
| Google Drive | Supabase Storage (bucket `attachments`) |
| MailApp (Gmail) | Brevo — ฟรี 300 ฉบับ/วัน ไม่ต้องมีโดเมน *(ไม่ตั้งค่าก็ได้ ระบบทำงานได้โดยไม่มีอีเมล)* |
| login PIN + token | เหมือนเดิมทุกประการ พนักงานไม่ต้องเรียนรู้ใหม่ |

## ขั้นตอน (ประมาณ 20 นาที)

### 1. สร้างโปรเจกต์ Supabase

1. สมัคร/login ที่ https://supabase.com (ฟรี ไม่ต้องใส่บัตร)
2. **New project** — ตั้งชื่อเช่น `leave`, Region เลือก **Southeast Asia (Singapore)**, ตั้ง Database password (เก็บไว้ ไม่ได้ใช้ในขั้นตอนนี้แต่ห้ามหาย)
3. รอสร้างเสร็จ ~2 นาที

### 2. สร้างตารางฐานข้อมูล

1. เมนูซ้าย **SQL Editor** > New query
2. วางเนื้อหาทั้งไฟล์ [supabase/schema.sql](supabase/schema.sql) > กด **Run**
3. ต้องขึ้น "Success" — เช็กที่เมนู **Table Editor** จะเห็น 6 ตาราง และ **Storage** จะมี bucket `attachments`

### 3. สร้าง Edge Function

1. เมนูซ้าย **Edge Functions** > **Deploy a new function** > เลือก **Via Editor**
2. ตั้งชื่อฟังก์ชันว่า `api` (ต้องชื่อนี้ ลิงก์ในอีเมลอ้างถึงมัน)
3. ลบโค้ดตัวอย่าง วางเนื้อหาทั้งไฟล์ [supabase/functions/api/index.ts](supabase/functions/api/index.ts) > กด **Deploy**
4. เข้าไปที่ function `api` > **Details** > ปิดสวิตช์ **Verify JWT with legacy secret / Enforce JWT verification** (สำคัญมาก — ไม่ปิดหน้าเว็บจะเรียกไม่ได้)

### 4. ตั้งค่า Secrets

เมนูซ้าย **Edge Functions > Secrets** (หรือ Project Settings > Edge Functions):

| ชื่อ | ค่า | จำเป็น? |
|---|---|---|
| `APP_SECRET` | ข้อความสุ่มยาว ๆ อย่างน้อย 40 ตัวอักษร (กดสุ่มจาก password generator ก็ได้) | ✅ บังคับ |
| `BREVO_API_KEY` | API key จาก Brevo (ดูหัวข้ออีเมลด้านล่าง) | ⬜ ถ้าต้องการอีเมล |
| `SENDER_EMAIL` | อีเมลผู้ส่งที่ยืนยันกับ Brevo แล้ว | ⬜ ถ้าต้องการอีเมล |

> ⚠️ `APP_SECRET` ตั้งแล้วห้ามเปลี่ยน — PIN ทุกคนผูกกับค่านี้ เปลี่ยนเมื่อไหร่ PIN ทั้งบริษัทใช้ไม่ได้ทันที

### 5. สร้างบัญชี admin คนแรก

Function URL จะอยู่ที่หน้า Edge Functions รูปแบบ `https://<project-ref>.supabase.co/functions/v1/api`

รันคำสั่งนี้ (แก้ URL, ชื่อ, PIN ตามจริง) — ใช้ได้ครั้งเดียวตอนตารางพนักงานยังว่าง:

```
curl -X POST "https://<project-ref>.supabase.co/functions/v1/api" -d "{\"action\":\"bootstrap\",\"emp_id\":\"EMP999\",\"name\":\"ฝ่ายบุคคล\",\"pin\":\"1234\"}"
```

ต้องได้ `{"ok":true,...}` กลับมา — หรือส่ง Function URL ให้ Claude รันให้ก็ได้

### 6. สลับหน้าเว็บมาใช้ Supabase (cutover)

แก้ [config.js](config.js) บรรทัดเดียว:

```js
const API_URL = 'https://<project-ref>.supabase.co/functions/v1/api';
```

push ขึ้น GitHub → Cloudflare deploy เอง → เปิดเว็บ login ด้วยบัญชี admin จากข้อ 5 → เพิ่มพนักงานทุกคนผ่านแท็บ "พนักงาน"

**ถอยกลับ (rollback):** แก้ `config.js` กลับเป็น URL ของ Apps Script เดิมแล้ว push — ระบบเก่ายังอยู่ครบ ไม่ได้ลบอะไร

## การย้ายข้อมูลเดิม

- **พนักงาน:** ต้องเพิ่มใหม่ผ่านเว็บ (PIN hash ของเดิมผูกกับ SECRET ของ Apps Script ย้ายไม่ได้) — ถือเป็นโอกาสตั้ง PIN ใหม่ให้ทุกคน
- **ประวัติใบลา:** ถ้าอยากเก็บ ให้ export แท็บ LeaveRequests เป็น CSV แล้วส่งให้ Claude แปลงเป็นคำสั่ง SQL insert ให้ หรือถ้าเพิ่งใช้ไม่นานจะเริ่มนับใหม่เลยก็ได้
- **วันหยุด/ประเภทลา/สิทธิ์รายคน:** schema.sql ใส่ค่าเริ่มต้นให้แล้ว แก้เพิ่มได้ใน Table Editor

## ตั้งค่าอีเมลแจ้งเตือน (Brevo — ทำทีหลังได้)

1. สมัคร https://www.brevo.com (ฟรี 300 ฉบับ/วัน)
2. ยืนยันอีเมลผู้ส่ง: Settings > Senders > Add a sender → ใช้อีเมลของคุณเอง ยืนยันผ่าน OTP (ไม่ต้องมีโดเมน)
3. สร้าง API key: Settings > SMTP & API > API Keys > Generate
4. เอาไปใส่ Secrets ตามข้อ 4 แล้วกด **Deploy** function ซ้ำหนึ่งครั้งเพื่อให้อ่านค่าใหม่

## เรื่องที่ควรรู้หลังย้าย

- **แผนฟรี pause เมื่อไม่มีการใช้งาน 7 วันติด** — ใช้งานปกติวันเว้นวันไม่โดน แต่ช่วงหยุดยาวอาจโดน เข้า dashboard กด Restore ได้ (ข้อมูลไม่หาย) หรือตั้ง cron ping กันไว้
- ดู/แก้ข้อมูลตรง ๆ ได้ที่ **Table Editor** ใน dashboard (แทนที่เคยเปิด Google Sheets)
- โหมดนับวันลา: แก้ในตาราง `settings` แถว `work_all_week` (`true` = นับทุกวัน / `false` = ข้ามเสาร์-อาทิตย์+วันหยุด) — ไม่ต้อง deploy ใหม่ มีผลทันที
- ไฟล์แนบเป็น public URL (เหมือน Drive แบบ anyone-with-link เดิม) — อย่าแนบเอกสารลับ
