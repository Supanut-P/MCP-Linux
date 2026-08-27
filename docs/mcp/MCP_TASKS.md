# baitonghub-linux-mcp + MCP Tasks spec (2025-11-25)

> สถานะ: experimental (ตามสเปก MCP Tasks รุ่น 2025-11-25)
> ใช้ได้ตั้งแต่รุ่นถัดจาก v4.7.1

baitonghub-linux-mcp เปิดดู durable background tasks ผ่านเมธอดระดับโปรโตคอลของ MCP Tasks
เพื่อให้ client ที่รองรับสเปกเรียกดู/เก็บผล/ยกเลิกงานยาวได้โดยไม่ต้องรู้จัก
ชื่อ tool ของ baitonghub-linux-mcp เอง

## ขอบเขต

- **ครอบคลุม**: durable background tasks ของ `shell`
  (ใช้ task store ที่รอดการ restart runtime ด้วย task ID)
- **ไม่รวม**: `process_start` (in-memory ไม่ durable — เป็น legacy path)
- **การสร้าง task ยังทำผ่าน tool เดิม**: `shell { execution: "background" }`
  — Tasks surface เป็นฝั่งอ่าน/เก็บผล/ยกเลิกเท่านั้น
- **ไม่ประกาศ `tasks.requests.tools.call`** ตามความตั้งใจ: client จึงจะไม่ส่ง
  task-augmented `tools/call` มา (Phase B — ดูท้ายเอกสาร)
- **ไม่ส่ง `notifications/tasks/status`** (optional ตามสเปก) — client ต้อง poll `tasks/get`

## เมธอดที่รองรับ

| เมธอด | พฤติกรรม |
| --- | --- |
| `tasks/get { taskId }` | สถานะล่าสุดของ task (ไม่พบ → `-32602`) |
| `tasks/result { taskId }` | ผลลัพธ์ (snapshot ของ task เป็น JSON text) เมื่อ task ถึง terminal; ติด `_meta['io.modelcontextprotocol/related-task']` ตามสเปก |
| `tasks/list { cursor? }` | รายการ task เรียงใหม่สุดก่อน + cursor pagination (หน้าละ 50) |
| `tasks/cancel { taskId }` | ยกเลิกงานที่ยังไม่ terminal; task terminal แล้ว → `-32602` |

Capability ที่ประกาศตอน initialize: `{ tasks: { list: {}, cancel: {} } }`

## การแม็ปสถานะ

| สถานะใน baitonghub-linux-mcp (shell-backend / durable store) | สถานะตามสเปก |
| --- | --- |
| `running` | `working` |
| `completed` | `completed` |
| `failed` | `failed` (+`statusMessage` จาก error) |
| `timed_out` | `failed` (+`statusMessage`) |
| `termination_unverified` | `working` (+`statusMessage` เพราะ process อาจยังมีชีวิต) |
| `cancelled` | `cancelled` |

ฟิลด์สังเคราะห์: `createdAt` = `started_at`, `lastUpdatedAt` = `finished_at ?? started_at`,
`ttl` = `deadline_at - started_at` (`null` ถ้าไม่มี deadline เช่น task แบบ in-memory)

`pollInterval` ใช้ค่า **MCP Poll / Tool Wait** จาก Settings: ตั้งได้ 5–60 วินาที
และค่าเริ่มต้นคือ 5 วินาที ค่าเดียวกันนี้ใช้เป็น request window ของ `tasks/result`
เพื่อให้พฤติกรรมการ poll ของ tool และ MCP Tasks สอดคล้องกัน

## Deviation ที่รู้ไว้ (เจตนา)

สเปกกำหนดให้ `tasks/result` block จนกว่า task จะถึง terminal — แต่ durable tasks
ของ baitonghub-linux-mcp ออกแบบให้ทำงานยาวเกินระยะเวลารอที่สมเหตุสมผลของ request หนึ่ง ๆ
ดังนั้น implementation นี้ block ได้สูงสุดตามค่า **MCP Poll / Tool Wait** ที่ผู้ใช้ตั้ง
(5–60 วินาที, ค่าเริ่มต้น 5 วินาที) แล้วตอบ `-32603` ถ้างานยังไม่ terminal
พร้อมข้อความชี้ให้กลับไป poll `tasks/get` ภายหลัง

เมื่อยังเป็น `working` หลังตรวจ 1–2 ครั้งใน ChatGPT turn เดียว ไม่ควร tight-poll ต่อเนื่อง
ให้เก็บ `taskId` ไว้แล้วคืน control ก่อน งาน durable จะยังทำต่อบนเครื่องและรอบถัดไป
สามารถใช้ task ID เดิมเพื่ออ่านสถานะ/log/result ได้ การหมด wait window ไม่ใช่การ cancel task

(กำกับไว้ในโค้ดที่ `packages/mcp-server/src/tasks-protocol.ts`)

## ความปลอดภัย

- Transport ทั้งหมด (loopback HTTP / stdio / Secure MCP Tunnel) อยู่ในขอบเขต
  เครื่องเดียวผู้ใช้เดียว — `tasks.list` เปิดใช้บนสมมติฐานนี้
- Task ID เป็น UUID v4 (random) ตามข้อกำหนด entropy ของสเปก
- ผลลัพธ์/log ผ่านการ redact ความลับของ shell backend เหมือนเดิม

## การทดสอบ

- Unit: `packages/mcp-server/src/tasks-protocol.test.ts`
- Integration (client จริงผ่าน HTTP loopback, ยุค 2025):
  `packages/mcp-server/src/tasks-protocol.integration.test.ts`

## Phase B — task-augmented tools/call (ยังไม่ทำ)

การรับ `tools/call` ที่แนบ `task` มาด้วย (ให้ server ตอบ `CreateTaskResult`
ทันทีแล้วค่อยเก็บผล) ยังเปิดไว้เป็นขั้นถัดไป เพราะต้อง override dispatcher
`tools/call` ของ SDK ทั้งตัว และยังไม่มี client เป้าหมายที่ใช้งานจริง
เมื่อจะทำ: ประกาศ `tasks.requests.tools.call` + `execution.taskSupport`
ใน tools/list ของ tool ที่รองรับ (เช่น `shell`)
