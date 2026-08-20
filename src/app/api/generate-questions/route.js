import { createClient } from '@supabase/supabase-js';

// Runs on Vercel's default Node runtime (not Edge) since it needs to reach
// generativelanguage.googleapis.com and may take longer than the default
// 10s on a busy generation — maxDuration extends that where the plan
// allows it; it's a no-op cap elsewhere.
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zwtulepvmlngcrbcrrki.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_XSAOmXfp00l6Lh0xLwXERQ_4UEgkWhS';

const DIFFICULTY_LABEL = { easy: 'ง่าย', medium: 'ปานกลาง', hard: 'ยาก' };
const MAX_QUESTIONS = 15;

export async function POST(request) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return Response.json({ error: 'กรุณาเข้าสู่ระบบ' }, { status: 401 });
  }

  // A client scoped to the caller's own access token, so every query below
  // runs under that user's RLS — subject ownership is enforced by the
  // database itself, not by application logic here.
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return Response.json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, { status: 401 });
  }

  // Shared config: public.config (key/value, readable by any authenticated
  // session per its own RLS) is the same table the ปพ.5 system already uses
  // to store this exact key, set from that system's settings page — reusing
  // it here means the exam app never needs its own Vercel-side secret for
  // this. GEMINI_API_KEY (a plain env var) is kept only as a fallback for
  // local dev, where .env.local is the natural place to put it.
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

  const { subjectId, indicatorIds = [], customTopic = '', difficulty = 'medium', numChoices = 4, numQuestions = 5 } = body;

  if (!subjectId) return Response.json({ error: 'กรุณาเลือกวิชา' }, { status: 400 });
  if (!DIFFICULTY_LABEL[difficulty]) return Response.json({ error: 'ระดับความยากไม่ถูกต้อง' }, { status: 400 });
  const choiceCount = Number(numChoices);
  if (!Number.isInteger(choiceCount) || choiceCount < 2 || choiceCount > 6) {
    return Response.json({ error: 'จำนวนตัวเลือกต้องอยู่ระหว่าง 2-6' }, { status: 400 });
  }
  const questionCount = Number(numQuestions);
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > MAX_QUESTIONS) {
    return Response.json({ error: `จำนวนข้อต้องอยู่ระหว่าง 1-${MAX_QUESTIONS}` }, { status: 400 });
  }
  if (indicatorIds.length === 0 && !customTopic.trim()) {
    return Response.json({ error: 'กรุณาเลือกตัวชี้วัดหรือระบุหัวข้อ' }, { status: 400 });
  }

  // RLS on subjects (owner-only + admin) means this returns nothing for a
  // subjectId the caller doesn't own — that's the ownership check, no extra
  // application-level guard needed.
  const { data: subject, error: subjectError } = await supabase
    .from('subjects')
    .select('id, subject_name, subject_group, grade_level')
    .eq('id', subjectId)
    .maybeSingle();
  if (subjectError) return Response.json({ error: subjectError.message }, { status: 500 });
  if (!subject) return Response.json({ error: 'ไม่พบวิชานี้ หรือไม่มีสิทธิ์เข้าถึง' }, { status: 403 });

  let indicators = [];
  if (indicatorIds.length > 0) {
    const { data, error } = await supabase
      .from('indicators')
      .select('id, indicator_code, indicator_text')
      .in('id', indicatorIds);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    indicators = data || [];
  }

  const topicLines = indicators.length > 0
    ? indicators.map(i => `- (${i.indicator_code}) ${i.indicator_text}`).join('\n')
    : `- ${customTopic.trim()}`;

  const prompt = `คุณเป็นครูผู้เชี่ยวชาญวิชา "${subject.subject_name}" ระดับชั้นมัธยมศึกษาปีที่ ${subject.grade_level} (กลุ่มสาระ ${subject.subject_group})

จงออกข้อสอบปรนัยจำนวน ${questionCount} ข้อ ระดับความยาก "${DIFFICULTY_LABEL[difficulty]}" แต่ละข้อมีตัวเลือก ${choiceCount} ตัวเลือก โดยอิงเนื้อหาตามตัวชี้วัด/หัวข้อต่อไปนี้ (สุ่มเลือกตัวชี้วัดที่จะใช้ในแต่ละข้อ ไม่จำเป็นต้องใช้ครบทุกข้อในทุกตัวชี้วัด):
${topicLines}

ข้อกำหนด:
- คำถามและตัวเลือกเป็นภาษาไทย ชัดเจน ไม่กำกวม เหมาะกับระดับชั้นที่ระบุ
- ตัวเลือกต้องมีความยาวและรูปแบบใกล้เคียงกัน เพื่อไม่ให้เดาคำตอบจากลักษณะตัวเลือกได้
- correct_choice คือดัชนีของตัวเลือกที่ถูกต้อง (เริ่มนับจาก 0)
- explanation อธิบายสั้นๆ ว่าทำไมตัวเลือกนั้นถูก`;

  const responseSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question_text: { type: 'string' },
            choices: { type: 'array', items: { type: 'string' }, minItems: choiceCount, maxItems: choiceCount },
            correct_choice: { type: 'integer' },
            explanation: { type: 'string' },
          },
          required: ['question_text', 'choices', 'correct_choice', 'explanation'],
        },
      },
    },
    required: ['questions'],
  };

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let geminiRes;
  try {
    geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
    });
  } catch {
    return Response.json({ error: 'ติดต่อ Gemini API ไม่สำเร็จ' }, { status: 502 });
  }

  if (!geminiRes.ok) {
    const detail = await geminiRes.text().catch(() => '');
    return Response.json({ error: `Gemini API ผิดพลาด (${geminiRes.status})`, detail }, { status: 502 });
  }

  const geminiData = await geminiRes.json();
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
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
    .filter(q => q && Array.isArray(q.choices) && q.choices.length === choiceCount
      && Number.isInteger(q.correct_choice) && q.correct_choice >= 0 && q.correct_choice < choiceCount
      && typeof q.question_text === 'string' && q.question_text.trim())
    .map(q => ({
      subject_id: subjectId,
      indicator_id: indicators.length === 1 ? indicators[0].id : null,
      difficulty,
      question_text: q.question_text.trim(),
      choices: q.choices.map(c => String(c).trim()),
      correct_choice: q.correct_choice,
      explanation: (q.explanation || '').trim(),
      source: 'ai',
    }));

  if (questions.length === 0) {
    return Response.json({ error: 'AI ไม่สามารถออกข้อสอบที่ใช้งานได้ ลองใหม่อีกครั้ง' }, { status: 502 });
  }

  return Response.json({ questions });
}
