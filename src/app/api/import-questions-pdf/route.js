import { createClient } from '@supabase/supabase-js';

// Runs on Vercel's default Node runtime (not Edge) — same reasoning as
// /api/generate-questions: needs to reach generativelanguage.googleapis.com
// and a PDF extraction call can take longer than the default 10s.
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zwtulepvmlngcrbcrrki.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_XSAOmXfp00l6Lh0xLwXERQ_4UEgkWhS';

const DIFFICULTY_LABEL = { easy: 'ง่าย', medium: 'ปานกลาง', hard: 'ยาก' };

// Vercel's Node serverless functions cap the REQUEST BODY at 4.5MB — the
// client base64-encodes the PDF into a JSON body (~33% larger than the raw
// file) with a little more JSON overhead on top, so the raw file itself
// needs real headroom under that cap. Enforced again here (not just
// client-side) since the client check is only a courtesy.
const MAX_PDF_BYTES = 3 * 1024 * 1024;

const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_ATTEMPT_TIMEOUT_MS = 45000;
const GEMINI_RETRY_DELAYS_MS = [1000, 2000];
const GEMINI_RETRYABLE_STATUSES = new Set([429, 503]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POSTs to Gemini's generateContent endpoint with a PDF as inline multimodal
 * data, retrying transient failures the same way /api/generate-questions
 * does. Returns { data } on success or { error, detail } once every attempt
 * is exhausted.
 */
async function fetchGeminiWithRetry(model, apiKey, prompt, pdfBase64, responseSchema) {
  let lastError = 'ติดต่อ Gemini API ไม่สำเร็จ';
  let lastDetail = '';

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        return { data: await res.json() };
      }

      lastError = `Gemini API ผิดพลาด (${res.status})`;
      lastDetail = await res.text().catch(() => '');
      if (!GEMINI_RETRYABLE_STATUSES.has(res.status)) {
        return { error: lastError, detail: lastDetail };
      }
    } catch (err) {
      lastError = err?.name === 'AbortError' ? 'Gemini API ไม่ตอบสนอง (timeout)' : 'ติดต่อ Gemini API ไม่สำเร็จ';
      lastDetail = '';
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < GEMINI_MAX_ATTEMPTS) {
      await sleep(GEMINI_RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  return { error: lastError, detail: lastDetail };
}

export async function POST(request) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return Response.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401 });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return Response.json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, { status: 401 });
  }

  const { data: configRow } = await supabase.from('config').select('value').eq('key', 'gemini_api_key').maybeSingle();
  const apiKey = configRow?.value || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ยังไม่ได้ตั้งค่า Gemini API Key ในเมนูตั้งค่า' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'รูปแบบคำขอไม่ถูกต้อง' }, { status: 400 });
  }

  const { subjectId, difficulty = 'medium', pdfBase64 = '' } = body;

  if (!subjectId) return Response.json({ error: 'กรุณาเลือกวิชา' }, { status: 400 });
  if (!DIFFICULTY_LABEL[difficulty]) return Response.json({ error: 'ระดับความยากไม่ถูกต้อง' }, { status: 400 });
  if (!pdfBase64) return Response.json({ error: 'กรุณาแนบไฟล์ PDF' }, { status: 400 });
  // base64 is ~4/3 the size of the decoded bytes.
  if (pdfBase64.length > (MAX_PDF_BYTES * 4) / 3) {
    return Response.json({ error: `ไฟล์ PDF ใหญ่เกินไป (จำกัดไม่เกิน ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB) ลองแยกเป็นไฟล์ย่อยหรือบีบอัดไฟล์ก่อน` }, { status: 400 });
  }

  const { data: subject, error: subjectError } = await supabase
    .from('subjects')
    .select('id, subject_name, subject_group, grade_level')
    .eq('id', subjectId)
    .maybeSingle();
  if (subjectError) return Response.json({ error: subjectError.message }, { status: 500 });
  if (!subject) return Response.json({ error: 'ไม่พบวิชานี้ หรือไม่มีสิทธิ์เข้าถึง' }, { status: 403 });

  const prompt = `คุณเป็นผู้ช่วยแปลงไฟล์ข้อสอบเป็นข้อมูลโครงสร้าง สำหรับวิชา "${subject.subject_name}" ระดับชั้นมัธยมศึกษาปีที่ ${subject.grade_level} (กลุ่มสาระ ${subject.subject_group})

อ่านไฟล์ PDF ที่แนบมา ซึ่งเป็นข้อสอบปรนัย แล้วดึงข้อมูลข้อสอบทุกข้อออกมาตามที่ปรากฏจริงในไฟล์ ห้ามแต่งคำถามหรือตัวเลือกขึ้นใหม่ ห้ามเปลี่ยนแปลงเนื้อหา — คัดลอกคำถามและตัวเลือกทุกข้อตามต้นฉบับ (แก้ไขได้เฉพาะการพิมพ์ผิดเล็กน้อยจาก OCR)

กติกาการดึงข้อมูล:
- แต่ละข้อ ดึงคำถาม (question_text) และตัวเลือกทั้งหมดตามลำดับเดิม (choices) — ตัดเลข/ตัวอักษรกำกับหน้าตัวเลือก (เช่น "ก.", "1.", "A.") ออก เหลือแต่ข้อความตัวเลือก
- ถ้าไฟล์มีเฉลย/คำตอบที่ถูกต้องระบุไว้ (ไม่ว่าจะอยู่ท้ายข้อ ท้ายไฟล์ หรือหน้าแยกต่างหาก) ให้ระบุ correct_choice เป็นดัชนีของตัวเลือกที่ถูก (เริ่มนับจาก 0) และใส่ explanation อธิบายสั้นๆ ถ้ามีข้อมูลเพียงพอ
- ถ้าไฟล์ไม่มีเฉลยระบุไว้เลย ให้ประเมินคำตอบที่ถูกต้องที่สุดตามความรู้วิชานี้ และใส่ "(AI ประเมินคำตอบเอง ยังไม่มีเฉลยในไฟล์ต้นฉบับ โปรดตรวจสอบ)" ต่อท้าย explanation เพื่อเตือนให้ครูตรวจทานอีกครั้ง
- ข้ามข้อที่อ่านไม่ออกหรือไม่ใช่ข้อสอบปรนัย (เช่น ข้อเขียนตอบ, ข้อจับคู่) ไปเลย ไม่ต้องพยายามแปลงให้เป็นปรนัย`;

  const responseSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question_text: { type: 'string' },
            choices: { type: 'array', items: { type: 'string' } },
            correct_choice: { type: 'integer' },
            explanation: { type: 'string' },
          },
          required: ['question_text', 'choices'],
        },
      },
    },
    required: ['questions'],
  };

  // "-latest" tracks Google's newest stable flash release automatically —
  // pinning a specific version (e.g. gemini-2.5-flash) means it silently
  // falls behind as Google ships new generations, with nothing here to
  // notice or update it.
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const geminiRes = await fetchGeminiWithRetry(model, apiKey, prompt, pdfBase64, responseSchema);
  if (geminiRes.error) {
    return Response.json({ error: geminiRes.error, detail: geminiRes.detail }, { status: 502 });
  }

  const text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return Response.json({ error: 'ไม่ได้รับผลลัพธ์จาก Gemini' }, { status: 502 });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: 'แปลงผลลัพธ์จาก Gemini ไม่สำเร็จ' }, { status: 502 });
  }

  const questions = (parsed.questions || [])
    .filter(q => q && Array.isArray(q.choices) && q.choices.length >= 2
      && typeof q.question_text === 'string' && q.question_text.trim())
    .map(q => {
      const choiceCount = q.choices.length;
      const hasValidAnswer = Number.isInteger(q.correct_choice) && q.correct_choice >= 0 && q.correct_choice < choiceCount;
      return {
        subject_id: subjectId,
        indicator_id: null,
        difficulty,
        question_text: q.question_text.trim(),
        choices: q.choices.map(c => String(c).trim()),
        correct_choice: hasValidAnswer ? q.correct_choice : 0,
        explanation: (q.explanation || '').trim(),
        source: 'manual',
        needs_review: !hasValidAnswer,
      };
    });

  if (questions.length === 0) {
    return Response.json({ error: 'ไม่พบข้อสอบปรนัยที่ดึงข้อมูลได้ในไฟล์นี้' }, { status: 502 });
  }

  return Response.json({ questions });
}
