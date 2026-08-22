'use client';
// /manual — คู่มือการใช้งานระบบสอบวัดผล ฉบับเต็ม สำหรับครู แอดมิน และนักเรียน
//
// Deliberately outside DashboardShell (no login required, no sidebar) —
// like /take, this is meant to be shareable as a plain link (e.g. to a new
// teacher who doesn't have an account yet, or printed and handed to a
// student). Uses the app-wide default font (Sarabun), not the
// DashboardShell-only Prompt, since this page serves every role, not just
// the teacher/admin dashboard.
//
// "พิมพ์คู่มือ / บันทึกเป็น PDF" just calls window.print() — the browser's
// own print dialog already offers "Save as PDF" as a destination, so no
// PDF-generation library is needed here. print:break-before-page on each
// major section keeps the PDF from splitting a section awkwardly across
// two pages.

import Link from 'next/link';

const card = 'bg-white border border-gray-200 rounded-xl p-5 sm:p-6';

function PrintIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 9V3h12v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M6 14h12v7H6z" />
    </svg>
  );
}

function ArrowLeftIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function Screenshot({ src, alt, caption }) {
  return (
    <figure className="my-4 print:break-inside-avoid">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="w-full max-w-xl mx-auto rounded-lg border border-gray-200 shadow-sm"
      />
      {caption && <figcaption className="text-xs text-gray-400 text-center mt-1.5">{caption}</figcaption>}
    </figure>
  );
}

function Section({ id, title, children }) {
  return (
    <section id={id} className={card + ' mb-5 scroll-mt-6 print:break-before-page print:shadow-none'}>
      <h2 className="text-lg font-bold text-gray-900 mb-3">{title}</h2>
      <div className="space-y-3 text-sm text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

function SubHeading({ children }) {
  return <h3 className="text-sm font-bold text-gray-900 mt-4 mb-1">{children}</h3>;
}

function Steps({ items }) {
  return (
    <ol className="list-decimal list-inside space-y-1 marker:text-gray-400">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ol>
  );
}

function Bullets({ items }) {
  return (
    <ul className="list-disc list-inside space-y-1 marker:text-gray-400">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  );
}

function Note({ children, tone = 'info' }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 border-amber-100 text-amber-800'
    : 'bg-indigo-50 border-indigo-100 text-indigo-800';
  return <div className={'rounded-lg border px-3 py-2 text-xs ' + cls}>{children}</div>;
}

const TOC = [
  { id: 'overview', label: 'ภาพรวมระบบ' },
  { id: 'teacher', label: 'สำหรับครู' },
  { id: 'teacher-login', label: '　เข้าสู่ระบบและแดชบอร์ด', indent: true },
  { id: 'teacher-omr', label: '　กระดาษคำตอบ (OMR)', indent: true },
  { id: 'teacher-bank', label: '　คลังข้อสอบ', indent: true },
  { id: 'teacher-examset', label: '　จัดข้อสอบ', indent: true },
  { id: 'teacher-schedule', label: '　จัดสอบ', indent: true },
  { id: 'teacher-monitor', label: '　คุมสอบ', indent: true },
  { id: 'teacher-duty', label: '　ตารางคุมสอบ', indent: true },
  { id: 'teacher-report', label: '　รายงาน', indent: true },
  { id: 'admin', label: 'สำหรับแอดมิน — ตั้งค่าระบบ' },
  { id: 'student', label: 'สำหรับนักเรียน' },
  { id: 'faq', label: 'คำถามที่พบบ่อย' },
];

export default function ManualPage() {
  return (
    <div className="min-h-dvh bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between gap-3 mb-6 print:hidden">
          <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
            <ArrowLeftIcon className="h-4 w-4" /> กลับสู่ระบบ
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90"
          >
            <PrintIcon className="h-4 w-4" /> พิมพ์คู่มือ / บันทึกเป็น PDF
          </button>
        </div>

        <div className="text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">คู่มือการใช้งานระบบสอบวัดผล</h1>
          <p className="mt-2 text-sm text-gray-500">
            คู่มือฉบับเต็มสำหรับครู แอดมิน และนักเรียน — อธิบายเมนู ฟีเจอร์ และขั้นตอนการใช้งานทีละส่วน
          </p>
        </div>

        <div className={card + ' mb-5 print:break-inside-avoid'}>
          <div className="text-sm font-bold text-gray-900 mb-2">สารบัญ</div>
          <nav className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {TOC.map(item => (
              <a key={item.id} href={`#${item.id}`} className={'hover:text-indigo-600 ' + (item.indent ? 'text-gray-500' : 'text-gray-800 font-semibold mt-1.5 sm:mt-0')}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>

        <Section id="overview" title="ภาพรวมระบบ">
          <p>
            <strong>ระบบสอบวัดผล</strong> เป็นระบบที่ช่วยครูสร้าง จัดสอบ และตรวจข้อสอบได้ทั้งแบบ
            <strong> กระดาษ (OMR — ตรวจด้วยกล้อง/สแกน)</strong> และแบบ <strong>สอบออนไลน์บนเว็บ</strong>
            ในระบบเดียวกัน มีผู้ใช้งาน 3 กลุ่มหลัก:
          </p>
          <Bullets items={[
            <><strong>ครูผู้สอน</strong> — สร้างข้อสอบ จัดสอบ คุมสอบ และดูรายงานผลของวิชาที่ตนเองสอน</>,
            <><strong>แอดมิน</strong> — ทำได้ทุกอย่างที่ครูทำได้ บวกกับตั้งค่าระบบส่วนกลาง (หน้า &quot;ตั้งค่า&quot;) และดูข้อมูลของครูทุกคนได้</>,
            <><strong>นักเรียน</strong> — เข้าทำข้อสอบออนไลน์ผ่านลิงก์ <code className="bg-gray-100 px-1 rounded">/take</code> โดยไม่ต้องมีบัญชีผู้ใช้ ใช้แค่รหัส PIN และเลขประจำตัวนักเรียนที่ครูแจ้ง</>,
          ]} />
          <Note>
            เมนูฝั่งครู/แอดมินแบ่งเป็น 2 กลุ่มใหญ่: <strong>&quot;คลังข้อสอบ&quot;</strong> (คลังข้อสอบ + จัดข้อสอบ — เตรียมคำถามและชุดข้อสอบ)
            และ <strong>&quot;กระดาษคำตอบ&quot;</strong> กับ <strong>&quot;สอบออนไลน์&quot;</strong> (สองช่องทางกาสอบจริงและตรวจผล) — ดูรายละเอียดแต่ละเมนูด้านล่าง
          </Note>
        </Section>

        {/* ================= ครู ================= */}

        <Section id="teacher-login" title="1. เข้าสู่ระบบและแดชบอร์ด">
          <p>เปิดลิงก์ระบบ แล้วกด &quot;เข้าสู่ระบบ&quot; ล็อกอินด้วยอีเมล/รหัสผ่านที่แอดมินสร้างให้</p>
          <Screenshot src="/manual/01-login.png" alt="หน้าแรกของระบบ" caption="หน้าแรก — กด “เข้าสู่ระบบ” เพื่อเข้าใช้งาน" />
          <p>
            เมื่อเข้าสู่ระบบแล้วจะเจอ <strong>แดชบอร์ด</strong> สรุปภาพรวม: จำนวนกระดาษคำตอบที่ตรวจแล้ว คะแนนเฉลี่ย
            ชุดข้อสอบออนไลน์ทั้งหมด รอบสอบที่กำลังดำเนินอยู่ พร้อมทางลัดไปยังเมนูที่ใช้บ่อย
          </p>
          <Screenshot src="/manual/02-dashboard.png" alt="หน้าแดชบอร์ด" caption="แดชบอร์ด — ภาพรวมการตรวจข้อสอบและสอบออนไลน์" />
          <p>
            เมนูด้านซ้ายกดปุ่ม <strong>☰</strong> เพื่อย่อ/ขยายเมนูได้ (มีประโยชน์บนจอเล็ก) และปุ่ม &quot;ออกจากระบบ&quot; อยู่มุมขวาบนเสมอ
          </p>
        </Section>

        <Section id="teacher-omr" title="2. กระดาษคำตอบ (OMR)">
          <p>ใช้สำหรับการสอบแบบกระดาษที่ให้นักเรียนฝนคำตอบ แล้วครูสแกน/ถ่ายรูปให้ระบบตรวจให้อัตโนมัติ มี 3 ขั้นตอนย่อย:</p>
          <SubHeading>2.1 กระดาษคำตอบ (เตรียมข้อสอบ + เฉลย)</SubHeading>
          <Steps items={[
            'เลือกวิชา ตั้งชื่อชุดข้อสอบ กำหนดจำนวนข้อและจำนวนตัวเลือกต่อข้อ',
            'กำหนดเฉลยแต่ละข้อ (มีช่อง “กำหนดคะแนนเท่ากันทุกข้อ” ให้ตั้งคะแนนทีเดียวทั้งชุดได้ ไม่ต้องกรอกทีละข้อ)',
            'พิมพ์กระดาษคำตอบ (แบบฟอร์มฝนคำตอบ) ออกมาแจกนักเรียนตอนสอบ',
          ]} />
          <SubHeading>2.2 สแกนตรวจ</SubHeading>
          <p>
            หลังนักเรียนฝนคำตอบเสร็จ ใช้กล้องมือถือ/เว็บแคมถ่ายภาพกระดาษคำตอบทีละแผ่น เลือกชื่อนักเรียนที่ตรงกับแผ่นนั้น
            ระบบจะอ่านช่องที่ฝนและตรวจให้อัตโนมัติ เห็นคะแนนทันทีหลังสแกน แผ่นที่สแกนไปแล้วสามารถกดดูผลซ้ำหรือ &quot;สแกนซ้ำ&quot;
            ได้หากสแกนผิดพลาด
          </p>
          <SubHeading>2.3 รายงาน (OMR)</SubHeading>
          <p>
            ดูผลคะแนนทุกคนของชุดข้อสอบที่เลือก พร้อม <strong>ผลการวิเคราะห์คุณภาพข้อสอบ</strong> (ค่าความยากและอำนาจจำแนกแต่ละข้อ)
            ส่งออกเป็น Excel/PDF ได้
          </p>
        </Section>

        <Section id="teacher-bank" title="3. คลังข้อสอบ">
          <p>
            ที่เก็บกลางของคำถามทั้งหมดที่ครูสร้างไว้ ใช้ได้ทั้งกับข้อสอบกระดาษและข้อสอบออนไลน์ สร้างคำถามได้ 3 วิธี:
          </p>
          <Bullets items={[
            <><strong>ให้ AI ช่วยออกข้อสอบ</strong> — เลือกวิชา ตัวชี้วัด/หน่วยการเรียนรู้ ระดับความยาก แล้วให้ AI ร่างคำถามให้ ตรวจทานและแก้ไขได้ก่อนบันทึก</>,
            <><strong>เพิ่มข้อสอบเอง</strong> — พิมพ์คำถาม/ตัวเลือก/เฉลยเอง แนบรูปประกอบได้</>,
            <><strong>นำเข้าจากไฟล์ CSV</strong> — ดาวน์โหลดแบบฟอร์มตัวอย่าง กรอกคำถามจำนวนมากในตารางแล้วนำเข้าทีเดียว</>,
          ]} />
          <Screenshot src="/manual/03-bank.png" alt="หน้าคลังข้อสอบ" caption="คลังข้อสอบ — รายการคำถามที่บันทึกไว้ พร้อมดาวคะแนนและความถี่การใช้งาน" />
          <p>
            แต่ละคำถามที่เคยใช้ในการสอบออนไลน์แล้วจะมี <strong>ดาวคะแนน (1-5 ดาว)</strong> ให้อัตโนมัติ — คำนวณจากค่าความยากและ
            อำนาจจำแนกจริงที่วัดได้จากผลสอบของนักเรียน (ยิ่งใช้ซ้ำหลายรอบยิ่งแม่นขึ้น) และป้าย <strong>&quot;ใช้ไปแล้ว N รอบสอบ&quot;</strong>
            บอกความถี่ที่เคยนำไปใช้ — ช่วยให้ครูรู้ว่าข้อไหน &quot;ใช้ได้ดี&quot; ข้อไหนควรปรับปรุงหรือเลี่ยงใช้ซ้ำ
          </p>
        </Section>

        <Section id="teacher-examset" title="4. จัดข้อสอบ">
          <p>
            นำคำถามจากคลังข้อสอบมาประกอบเป็น <strong>ชุดข้อสอบ</strong> สำหรับใช้สอบออนไลน์ (ชุดข้อสอบไม่มีเวลา/PIN ในตัวเอง —
            เวลาและ PIN ตั้งแยกที่เมนู &quot;จัดสอบ&quot;)
          </p>
          <Screenshot src="/manual/04-examset.png" alt="หน้าจัดข้อสอบ" caption="จัดข้อสอบ — เลือกคำถามจากคลัง กรองและจัดลำดับ ก่อนสร้างชุดข้อสอบ" />
          <Steps items={[
            'เลือกวิชา ตั้งชื่อชุดข้อสอบ',
            'ติ๊กเลือกคำถามจากคลังทางซ้าย — ใช้ตัวกรอง “ระดับความยาก / ตัวชี้วัด-ผลการเรียนรู้ / ดาวคะแนน” ช่วยหาคำถามที่ต้องการได้เร็วขึ้น',
            'จัดลำดับข้อ (เลื่อนขึ้น/ลง) และกำหนดคะแนนแต่ละข้อทางขวา (มีปุ่ม “กำหนดคะแนนเท่ากันทุกข้อ” ให้ตั้งครั้งเดียวทั้งชุด)',
            'กด “สร้างชุดข้อสอบ”',
          ]} />
          <p>
            ชุดข้อสอบที่สร้างไว้แล้วสามารถ <strong>พิมพ์ข้อสอบ (A4)</strong> เป็น PDF หรือ Word ได้ (เผื่อใช้เป็นข้อสอบกระดาษสำรอง —
            ระบบจะตั้งเฉลยให้ในฝั่ง OMR ให้อัตโนมัติด้วย) หรือ <strong>คัดลอกไปอีกห้อง</strong> เมื่อสอนวิชาเดียวกันหลายห้อง
            โดยไม่ต้องพิมพ์ข้อสอบซ้ำ
          </p>
        </Section>

        <Section id="teacher-schedule" title="5. จัดสอบ">
          <p>นำชุดข้อสอบที่สร้างไว้มาตั้งเป็น &quot;รอบสอบ&quot; จริง — กำหนดช่วงเวลาเปิด/ปิดรับเข้าสอบ เวลาทำต่อคน และรหัส PIN</p>
          <Screenshot src="/manual/05-schedule.png" alt="หน้าจัดสอบ" caption="จัดสอบ — ตั้งเวลาสอบ รหัส PIN และรหัสปลดล็อกสำหรับครูคุมสอบ" />
          <Bullets items={[
            <><strong>รหัส PIN</strong> — แจ้งให้นักเรียนใช้เข้าสอบ (สุ่มให้อัตโนมัติ กดปุ่ม &quot;สุ่มใหม่&quot; เพื่อเปลี่ยนได้)</>,
            <><strong>รหัสปลดล็อก</strong> — คนละรหัสกับ PIN ใช้เฉพาะครูคุมสอบตอนนักเรียนทำผิดกฎจนหน้าจอถูกล็อก (ห้ามให้นักเรียนรู้)</>,
            <><strong>บังคับแชร์ตำแหน่งก่อนเข้าสอบ</strong> — ติ๊กเมื่อให้นักเรียนสอบจากที่บ้าน เพื่อป้องกันนักเรียนนั่งใกล้กันเกินไป (ดูรายละเอียดที่หัวข้อ &quot;คุมสอบ&quot; และ &quot;สำหรับนักเรียน&quot;)</>,
            'เลือกวิธีเปิดเผยผลคะแนน — กดปุ่มเปิดเผยเองทีหลัง หรือให้ระบบแสดงอัตโนมัติทันทีที่นักเรียนส่งข้อสอบ/หมดเวลา',
          ]} />
          <p>
            แต่ละรอบมีปุ่ม <strong>พิมพ์รายละเอียดรอบสอบ</strong> (PIN + รหัสปลดล็อก สำหรับครูคุมสอบพกกระดาษเข้าห้องสอบ) และ
            <strong> พิมพ์ป้าย QR เข้าสอบ</strong> (ให้นักเรียนสแกนเข้าลิงก์สอบโดยไม่ต้องพิมพ์ URL เอง)
          </p>
        </Section>

        <Section id="teacher-monitor" title="6. คุมสอบ">
          <p>
            หน้าจอเรียลไทม์สำหรับดูสถานะนักเรียนขณะกำลังสอบอยู่ — เลือกรอบสอบ (หรือดูรวมทั้งห้องตามตารางคุมสอบ) จะเห็นรายชื่อ
            นักเรียนพร้อมสถานะ: ยังไม่เข้าสอบ / กำลังทำ / ส่งแล้ว รวมถึงจำนวนครั้งที่สลับหน้าจอออกจากการสอบ (การทำผิดกฎ)
          </p>
          <Bullets items={[
            'นักเรียนที่ทำผิดกฎเกินจำนวนที่ตั้งไว้ หน้าจอจะถูกล็อกอัตโนมัติ — ครูแจ้งรหัสปลดล็อกของรอบสอบนั้นให้นักเรียนกรอกเพื่อทำต่อ',
            'ครูสามารถกดล็อก/ปลดล็อกนักเรียนคนใดคนหนึ่งเองได้จากหน้านี้โดยตรง',
            'ถ้ารอบสอบเปิด “บังคับแชร์ตำแหน่ง” ไว้ หน้านี้จะมีแผนที่แสดงตำแหน่งนักเรียนแต่ละคน และขึ้นธงเตือน (ไม่บล็อกอัตโนมัติ) เมื่อมีคู่ใดนั่งใกล้กันน้อยกว่าระยะที่กำหนด ให้ครูตัดสินใจเองว่าจะบล็อกหรือไม่',
          ]} />
        </Section>

        <Section id="teacher-duty" title="7. ตารางคุมสอบ">
          <p>
            สำหรับดูและมอบหมายว่าวันไหน ครูคนไหนคุมสอบห้อง/ชั้นใดบ้าง (ใช้ร่วมกับรอบสอบแบบ &quot;ในตาราง&quot; ที่ตั้งไว้ตอนจัดสอบ)
            พิมพ์ตารางคุมสอบรายวันออกมาแปะประกาศได้ — การมอบหมายครูคุมสอบทำที่หน้า &quot;ตั้งค่า&quot; (แอดมินเท่านั้น)
          </p>
        </Section>

        <Section id="teacher-report" title="8. รายงาน (สอบออนไลน์)">
          <p>เลือกรอบสอบเพื่อดูผลคะแนนนักเรียนทุกคน สถานะการเข้าสอบ จำนวนครั้งที่สลับหน้าจอ พร้อมปุ่มรีเซ็ตให้สอบใหม่รายบุคคล</p>
          <p>
            ด้านล่างมี <strong>ผลการวิเคราะห์คุณภาพข้อสอบ</strong> — ตารางค่าความยาก (p) และอำนาจจำแนก (r) ของแต่ละข้อ พร้อมคำแนะนำ
            &quot;ใช้ได้&quot;/&quot;ควรปรับปรุงหรือตัดทิ้ง&quot; และค่าความเชื่อมั่นของแบบทดสอบทั้งชุด (KR-20) ส่งออกเป็น Excel/PDF ได้ —
            ตัวเลขชุดนี้เป็นข้อมูลเดียวกับที่ใช้คำนวณดาวคะแนนในหน้าคลังข้อสอบ
          </p>
        </Section>

        {/* ================= แอดมิน ================= */}

        <Section id="admin" title="สำหรับแอดมิน — ตั้งค่าระบบ">
          <p>เมนู &quot;ตั้งค่า&quot; มองเห็นเฉพาะบัญชีแอดมินเท่านั้น รวมการตั้งค่าส่วนกลางทั้งหมดของระบบไว้ในหน้าเดียว:</p>
          <Screenshot src="/manual/06-settings.png" alt="หน้าตั้งค่าระบบ" caption="ตั้งค่าระบบ — รวมการตั้งค่าส่วนกลางทั้งหมด" />
          <Bullets items={[
            <><strong>ชื่อระบบ คำอธิบาย และโลโก้</strong> — ปรับแต่งชื่อ/โลโก้ที่แสดงในเมนูและหน้าเข้าสอบของนักเรียน</>,
            <><strong>ชุดข้อสอบทั้งหมดในระบบ</strong> / <strong>รูปกระดาษคำตอบที่ครูเก็บไว้ทั้งหมด</strong> — แอดมินดูและลบของครูคนใดก็ได้ (ลบแล้วกู้คืนไม่ได้)</>,
            <><strong>Gemini API Key</strong> — คีย์ AI ที่ใช้สร้างข้อสอบในหน้าคลังข้อสอบ ใช้ร่วมกับระบบ ปพ.5</>,
            <><strong>ป้องกันการทุจริตในการสอบออนไลน์</strong> — ตั้งจำนวนครั้งสูงสุดที่อนุญาตให้สลับหน้าจอก่อนถูกส่งข้อสอบอัตโนมัติ</>,
            <><strong>ตรวจสอบตำแหน่งนักเรียน (สอบที่บ้าน)</strong> — สวิตช์เปิด/ปิดฟีเจอร์นี้ทั้งระบบ และระยะห่างขั้นต่ำ (เมตร) ที่ถือว่า &quot;ใกล้กันเกินไป&quot; — ปิดสวิตช์นี้แล้ว ครูจะไม่เห็นตัวเลือก &quot;บังคับแชร์ตำแหน่ง&quot; ที่หน้าจัดสอบอีกเลย</>,
            <><strong>มอบหมายครูคุมสอบ (สอบในตาราง)</strong> — เลือกวันที่ ชั้น/ห้อง แล้วมอบหมายครูที่จะเห็นมอนิเตอร์คุมสอบของห้องนั้นในวันนั้น</>,
            <><strong>Log ระบบการสอบ</strong> — ประวัติเหตุการณ์ล่าสุดของระบบสอบออนไลน์ (เข้าสอบ สลับหน้าจอ ล็อก/ปลดล็อก ส่งข้อสอบ) 200 รายการล่าสุด สำหรับตรวจสอบย้อนหลัง</>,
          ]} />
        </Section>

        {/* ================= นักเรียน ================= */}

        <Section id="student" title="สำหรับนักเรียน">
          <p>
            นักเรียนไม่ต้องสมัครบัญชี — เปิดลิงก์ที่ครูให้ (หรือสแกน QR จากป้ายที่ครูพิมพ์แจก) แล้วกรอก <strong>รหัส PIN</strong>
            กับ <strong>เลขประจำตัวนักเรียน</strong> ที่ครูแจ้งไว้
          </p>
          <Screenshot src="/manual/07-student-login.png" alt="หน้าเข้าสอบของนักเรียน" caption="หน้าเข้าสอบออนไลน์ — กรอกรหัส PIN และเลขประจำตัวนักเรียน" />

          <SubHeading>กฎการสอบที่ควรรู้</SubHeading>
          <Bullets items={[
            'ก่อนเริ่มทำข้อสอบ ระบบจะแจ้งกฎการสอบและให้ติ๊กยืนยันว่าอ่านแล้วก่อนเข้าสอบทุกครั้ง',
            'ห้ามสลับแท็บ/แอปอื่น ย่อหน้าจอ หรือปล่อยให้จอดับ/ล็อกเองระหว่างสอบ — ระบบนับเป็น “การทำผิดกฎ” ทุกครั้งที่ออกจากหน้าจอทำข้อสอบ',
            'ทำผิดกฎครบตามจำนวนที่ครูตั้งไว้ ระบบจะส่งข้อสอบให้อัตโนมัติทันที แม้ยังไม่หมดเวลา',
            'ทุกครั้งที่ทำผิดกฎ หน้าจอจะถูกล็อกทันที ต้องรอครูคุมสอบกรอกรหัสปลดล็อกให้ก่อนจึงทำต่อได้',
            'ปิดแอป/รีเฟรชหน้าได้ คำตอบที่ทำไว้จะไม่หาย แต่เวลาสอบยังเดินต่อตามปกติ ไม่หยุดรอ',
          ]} />
          <Note tone="warn">
            สำคัญ: ควรปิดการล็อกหน้าจออัตโนมัติของอุปกรณ์ หรือตั้งเวลาจอดับให้นานกว่าเวลาสอบก่อนเริ่มทำข้อสอบ —
            จอดับ/ล็อกเองก็ถูกนับเป็นการทำผิดกฎเช่นกัน
          </Note>

          <SubHeading>ถ้ารอบสอบนี้บังคับแชร์ตำแหน่ง (สอบที่บ้าน)</SubHeading>
          <p>
            รอบสอบบางรอบที่ครูตั้งให้สอบจากที่บ้าน จะขอให้นักเรียนกดอนุญาตแชร์ตำแหน่ง (GPS) ก่อนเริ่มทำข้อสอบเสมอ —
            ใช้ตรวจสอบเบื้องต้นว่านักเรียนไม่ได้นั่งใกล้กันเกินระยะที่ครูกำหนดเท่านั้น <strong>เข้าสอบไม่ได้จนกว่าจะแชร์ตำแหน่งสำเร็จ</strong>
            หากปฏิเสธหรืออุปกรณ์หา GPS ไม่ได้ ให้กด &quot;ลองอีกครั้ง&quot; (อาจต้องเปิดสิทธิ์ตำแหน่งให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ก่อน)
          </p>
          <Screenshot src="/manual/08-student-locating.png" alt="หน้าขอสิทธิ์แชร์ตำแหน่งก่อนเข้าสอบ" caption="หน้าแชร์ตำแหน่งก่อนเข้าสอบ (แสดงเฉพาะรอบที่ครูเปิดใช้ฟีเจอร์นี้)" />

          <SubHeading>หน้าทำข้อสอบ</SubHeading>
          <p>
            ตอบคำถามทีละข้อโดยเลือกตัวเลือก ระบบบันทึกคำตอบไว้ในเครื่องอัตโนมัติทุกครั้งที่เลือก (กันลืมกดบันทึก)
            เมื่อทำครบแล้วกด &quot;ส่งข้อสอบ&quot; — ส่งแล้วแก้ไขคำตอบไม่ได้อีก
          </p>
          <Screenshot src="/manual/09-student-exam.png" alt="หน้าทำข้อสอบของนักเรียน" caption="หน้าทำข้อสอบ — นาฬิกานับถอยหลังและลายน้ำชื่อ-เวลากำกับทุกหน้าจอ" />
          <p>
            หลังส่งข้อสอบ จะเห็นคะแนนทันที (ถ้ารอบสอบตั้งเปิดเผยผลอัตโนมัติ) หรือต้องรอครูกดเปิดเผยผลทีหลัง — เข้าลิงก์เดิมด้วย
            PIN + เลขประจำตัวเดิมอีกครั้งเพื่อดูผลคะแนนได้เมื่อครูเปิดเผยแล้ว
          </p>
        </Section>

        {/* ================= FAQ ================= */}

        <Section id="faq" title="คำถามที่พบบ่อย">
          <SubHeading>นักเรียนลืม PIN หรือ PIN ใช้ไม่ได้ ทำอย่างไร?</SubHeading>
          <p>ตรวจสอบที่หน้า &quot;จัดสอบ&quot; ว่า PIN ตรงกับรอบสอบที่ถูกต้อง และยังอยู่ในช่วงเวลาเปิด-ปิดรับเข้าสอบหรือไม่</p>

          <SubHeading>หน้าจอนักเรียนถูกล็อก ต้องทำอย่างไร?</SubHeading>
          <p>
            ให้ครูคุมสอบดูรหัสปลดล็อกของรอบสอบนั้น (จากหน้า &quot;จัดสอบ&quot; หรือใบพิมพ์รายละเอียดรอบสอบ) แล้วบอกให้นักเรียนกรอก
            ในกล่องที่ค้างอยู่หน้าจอนักเรียน — ห้ามบอก PIN เข้าสอบผิดเป็นรหัสปลดล็อก เป็นคนละรหัสกัน
          </p>

          <SubHeading>สแกนกระดาษคำตอบแล้วผลไม่ตรง ทำอย่างไร?</SubHeading>
          <p>ถ่ายภาพให้กระดาษคำตอบอยู่ในกรอบเต็มแผ่น แสงสว่างเพียงพอ ไม่มีเงาบัง แล้วกด &quot;สแกนซ้ำ&quot; ที่รายชื่อนักเรียนคนนั้นได้ทันที</p>

          <SubHeading>ทำไมดาวคะแนนในคลังข้อสอบของบางข้อไม่ขึ้น?</SubHeading>
          <p>
            ดาวคะแนนคำนวณจากผลสอบจริงของนักเรียน — ข้อที่ยังไม่เคยถูกใช้ในรอบสอบออนไลน์ใดเลย หรือใช้แล้วแต่มีผู้เข้าสอบไม่ถึง 2 คน
            จะยังไม่มีข้อมูลเพียงพอให้คำนวณ ระบบจะยังไม่แสดงดาวจนกว่าจะมีข้อมูลมากพอ
          </p>

          <SubHeading>ต้องการพิมพ์คู่มือนี้เก็บไว้ ทำอย่างไร?</SubHeading>
          <p>กดปุ่ม &quot;พิมพ์คู่มือ / บันทึกเป็น PDF&quot; ที่ด้านบนของหน้านี้ แล้วเลือกปลายทางเป็น &quot;บันทึกเป็น PDF&quot; ในหน้าต่างพิมพ์ของเบราว์เซอร์</p>
        </Section>

        <div className="text-center text-xs text-gray-400 mt-8 print:hidden">
          มีคำถามเพิ่มเติมที่คู่มือนี้ไม่ครอบคลุม ติดต่อแอดมินของโรงเรียนได้โดยตรง
        </div>
      </div>
    </div>
  );
}
