// The "ข้อควรทราบก่อนเริ่มสอบ" notice every student must tick through
// before an online exam starts (StudentExamTool). Admins can replace the
// text in Settings; it's stored as plain text in public.config (anon-
// readable, admin-write-only — see migration exam_rules_notice_config) and
// falls back to DEFAULT_EXAM_RULES when unset or blank.
//
// Format, kept deliberately tiny so a non-technical admin can edit it:
//   - one rule per line (blank lines are dropped)
//   - **text** renders bold
//   - {max} becomes the round's allowed violation count
// Everything else is HTML-escaped before rendering, since the result goes
// into SweetAlert's raw `html` option in every student's browser.

import { escapeHtml } from './format';

export const EXAM_RULES_CONFIG_KEY = 'exam_rules_notice';

export const DEFAULT_EXAM_RULES = [
  '• ระบบตรวจจับการออกจากหน้าจอทำข้อสอบ (สลับแท็บ/แอปอื่น ย่อหน้าจอ จอดับ หรือล็อกหน้าจอ) ทุกครั้งจะถูกบันทึกเป็น **การทำผิดกฎ 1 ครั้ง**',
  '• อนุญาตให้ทำผิดได้สูงสุด **{max} ครั้ง** — เกินกว่านี้ระบบจะ**ส่งข้อสอบให้อัตโนมัติทันที** แม้ยังไม่หมดเวลา',
  '• ทุกครั้งที่ทำผิดกฎ หน้าจอจะถูกล็อก ต้องรอ**ครูคุมสอบกรอกรหัสปลดล็อก**ให้ก่อนจึงทำต่อได้',
  '⚠️ **กรุณาปิดการล็อกหน้าจออัตโนมัติ (Auto-Lock)** หรือตั้งเวลาจอดับให้นานกว่าเวลาสอบ — จอดับ/ล็อกเองก็ถูกนับเป็นการทำผิดกฎเช่นกัน',
  '• ควรเชื่อมต่ออินเทอร์เน็ตให้เสถียรตลอดการสอบ',
  '• หน้าจอมีลายน้ำระบุชื่อและเวลาของคุณกำกับอยู่ เพื่อป้องกันการแคปหน้าจอไปเผยแพร่',
  '• ปิดแอป/รีเฟรชหน้าได้โดยคำตอบที่ทำไว้จะไม่หาย แต่**เวลาสอบยังเดินต่อตามปกติ** ไม่หยุดรอ',
].join('\n');

export function renderExamRulesHtml(text, maxViolations) {
  const source = text && text.trim() ? text : DEFAULT_EXAM_RULES;
  const lines = source.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const body = lines.map(line => {
    const html = escapeHtml(line)
      .replace(/\{max\}/g, escapeHtml(String(maxViolations ?? '')))
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    return `<p>${html}</p>`;
  }).join('');
  return `<div style="text-align:left;font-size:0.875rem;line-height:1.6">${body}</div>`;
}
