'use client';
// BankTool.jsx
//
// AI-assisted question bank: pick a subject, pick one or more core-
// curriculum indicators (or type a free topic for subjects the reference
// table doesn't cover), pick difficulty/choice count/how many questions,
// then call /api/generate-questions (the only place that touches the
// server-side Gemini key) to get an editable draft. The teacher reviews
// and can edit every field before saving into bank_questions.
//
// Below the generator sits a browse/delete list of everything already
// saved to the bank, grouped by subject.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { listMySubjects, listIndicatorsForSubject, listEvalPlanUnitsForSubject, listMyBankQuestions, saveBankQuestions, deleteBankQuestion } from '../lib/bank-db';
import ConfirmDialog from './ConfirmDialog';

const DIFFICULTIES = [
  { value: 'easy', label: 'ง่าย' },
  { value: 'medium', label: 'ปานกลาง' },
  { value: 'hard', label: 'ยาก' },
];

const KINDS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'ระหว่างทาง', label: 'ระหว่างทาง' },
  { value: 'ปลายทาง', label: 'ปลายทาง' },
];

function SparkleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

function BankIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </svg>
  );
}

function TrashIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function SaveIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v5h8V4M8 14h8v6H8z" />
    </svg>
  );
}

function ChevronDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PencilIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

const SOURCE_LABEL = { ai: 'AI สร้าง', manual: 'ครูสร้างเอง' };

function useExpandedGroups() {
  const [expanded, setExpanded] = useState(new Set());
  const toggle = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return [expanded, toggle];
}

function groupBySubject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.subjects?.subject_name} (ชั้น ${item.subjects?.grade_level}/${item.subjects?.room})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

export default function BankTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-90 inline-flex items-center justify-center gap-2';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';
  const chip = 'px-3 py-1.5 rounded-full text-xs font-semibold border transition';
  const chipActive = chip + ' bg-indigo-600 border-indigo-600 text-white';
  const chipInactive = chip + ' bg-white border-gray-300 text-gray-600 hover:border-indigo-300';

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [indicators, setIndicators] = useState([]);
  const [indicatorIds, setIndicatorIds] = useState([]);
  const [units, setUnits] = useState([]);
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const [sourceMode, setSourceMode] = useState('indicators'); // 'indicators' | 'units' | 'custom'
  const [kindFilter, setKindFilter] = useState('');
  const [customTopic, setCustomTopic] = useState('');
  const [difficulty, setDifficulty] = useState('medium');
  const [numChoices, setNumChoices] = useState(4);
  const [numQuestions, setNumQuestions] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [draftQuestions, setDraftQuestions] = useState([]);
  const [saving, setSaving] = useState(false);

  const [bankQuestions, setBankQuestions] = useState([]);
  const [bankLoading, setBankLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, toggleGroup] = useExpandedGroups();

  const selectedSubject = subjects.find(s => s.id === subjectId) || null;

  const refreshBank = useCallback(async () => {
    setBankLoading(true);
    try {
      setBankQuestions(await listMyBankQuestions(supabase));
    } catch {
      // best-effort — the generator above still works
    } finally {
      setBankLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setSubjects(await listMySubjects(supabase));
      } catch {
        // best-effort
      }
    })();
    refreshBank();
  }, [refreshBank]);

  useEffect(() => {
    setIndicatorIds([]);
    setIndicators([]);
    setUnits([]);
    setSelectedUnitId('');
    setCustomTopic('');
    setKindFilter('');
    if (!selectedSubject) return;
    (async () => {
      try {
        const [inds, us] = await Promise.all([
          listIndicatorsForSubject(supabase, selectedSubject),
          listEvalPlanUnitsForSubject(supabase, selectedSubject.id),
        ]);
        setIndicators(inds);
        setUnits(us);
        setSourceMode(inds.length > 0 ? 'indicators' : (us.length > 0 ? 'units' : 'custom'));
      } catch {
        // best-effort — falls back to the custom-topic field
        setSourceMode('custom');
      }
    })();
  }, [selectedSubject]);

  function toggleIndicator(id) {
    setIndicatorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  const filteredIndicators = kindFilter ? indicators.filter(i => i.kind === kindFilter) : indicators;

  function selectUnit(unit) {
    setSelectedUnitId(unit.id);
    if (unit.indicators.length > 0) {
      setIndicatorIds(unit.indicators.map(i => i.id));
      setCustomTopic('');
    } else {
      setIndicatorIds([]);
      setCustomTopic(unit.unit_name);
    }
  }

  // Switching source clears whatever the other two modes had picked, so the
  // request sent to /api/generate-questions always reflects only the
  // currently-visible picker, never a stale mix of indicatorIds from one
  // mode plus customTopic typed in another.
  function switchSource(mode) {
    setSourceMode(mode);
    setIndicatorIds([]);
    setSelectedUnitId('');
    setCustomTopic('');
  }

  async function handleGenerate() {
    setGenerateError(null);
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/generate-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          subjectId, indicatorIds, customTopic, difficulty,
          numChoices: Number(numChoices), numQuestions: Number(numQuestions),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'สร้างข้อสอบไม่สำเร็จ');
      setDraftQuestions(body.questions.map((q, i) => ({ ...q, _key: `${Date.now()}-${i}` })));
    } catch (err) {
      setGenerateError(err.message || 'สร้างข้อสอบไม่สำเร็จ');
    } finally {
      setGenerating(false);
    }
  }

  // Adds one blank hand-written question to the same draft-review list the
  // AI generator fills, carrying the subject/indicator/difficulty already
  // picked in step 1 and source:'manual' so it's labeled and saved
  // distinctly from AI-drafted ones, even when both sit in the list
  // together before "บันทึกเข้าคลังทั้งหมด".
  function handleAddManual() {
    setDraftQuestions(prev => [...prev, {
      subject_id: subjectId,
      indicator_id: indicatorIds.length === 1 ? indicatorIds[0] : null,
      difficulty,
      question_text: '',
      choices: Array(Number(numChoices) || 4).fill(''),
      correct_choice: 0,
      explanation: '',
      source: 'manual',
      _key: `manual-${Date.now()}`,
    }]);
  }

  function updateDraft(key, patch) {
    setDraftQuestions(prev => prev.map(q => q._key === key ? { ...q, ...patch } : q));
  }

  function updateDraftChoice(key, idx, value) {
    setDraftQuestions(prev => prev.map(q => {
      if (q._key !== key) return q;
      const choices = [...q.choices];
      choices[idx] = value;
      return { ...q, choices };
    }));
  }

  function removeDraft(key) {
    setDraftQuestions(prev => prev.filter(q => q._key !== key));
  }

  const hasIncompleteDraft = draftQuestions.some(q => !q.question_text.trim() || q.choices.some(c => !c.trim()));

  async function handleSaveAll() {
    if (draftQuestions.length === 0) return;
    setSaving(true);
    try {
      await saveBankQuestions(supabase, draftQuestions);
      setDraftQuestions([]);
      refreshBank();
    } catch (err) {
      setGenerateError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteBankQuestion(supabase, deleteTarget.id);
      setDeleteTarget(null);
      refreshBank();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <BankIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">คลังข้อสอบ</h1>
          <p className="text-sm text-gray-500">ให้ AI ช่วยออกข้อสอบตามตัวชี้วัด แล้วตรวจทานก่อนบันทึกเข้าคลัง</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <div className="font-semibold text-gray-900 mb-3">1. เลือกวิชาและตัวชี้วัด</div>
        <div className={row}>
          <div className={field}>
            <label className={label}>วิชา</label>
            <select className={inputCls} value={subjectId} onChange={e => setSubjectId(e.target.value)}>
              <option value="">— เลือกวิชา —</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.subject_name} (ชั้น {s.grade_level}/{s.room})</option>
              ))}
            </select>
          </div>
          <div className={field}>
            <label className={label}>ระดับความยาก</label>
            <select className={inputCls} value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              {DIFFICULTIES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
          <div className={field}>
            <label className={label}>จำนวนตัวเลือก</label>
            <input type="number" min={2} max={6} className={inputCls + ' w-24'} value={numChoices} onChange={e => setNumChoices(e.target.value)} />
          </div>
          <div className={field}>
            <label className={label}>จำนวนข้อ</label>
            <input type="number" min={1} max={15} className={inputCls + ' w-24'} value={numQuestions} onChange={e => setNumQuestions(e.target.value)} />
          </div>
        </div>

        {selectedSubject && (
          <div className="mt-4">
            <div className="flex flex-wrap gap-2 mb-3">
              {indicators.length > 0 && (
                <button type="button" className={sourceMode === 'indicators' ? chipActive : chipInactive} onClick={() => switchSource('indicators')}>
                  ตัวชี้วัดมาตรฐาน ({indicators.length})
                </button>
              )}
              {units.length > 0 && (
                <button type="button" className={sourceMode === 'units' ? chipActive : chipInactive} onClick={() => switchSource('units')}>
                  หน่วยการเรียนรู้ (แผนการวัดผล) ({units.length})
                </button>
              )}
              <button type="button" className={sourceMode === 'custom' ? chipActive : chipInactive} onClick={() => switchSource('custom')}>
                พิมพ์หัวข้อเอง
              </button>
            </div>

            {sourceMode === 'indicators' && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <label className={label}>ประเภทตัวชี้วัด</label>
                  {KINDS.map(k => (
                    <button key={k.value} type="button" className={kindFilter === k.value ? chipActive : chipInactive} onClick={() => setKindFilter(k.value)}>
                      {k.label}
                    </button>
                  ))}
                </div>
                <label className={label}>ตัวชี้วัด (เลือกได้หลายข้อ)</label>
                <div className="mt-1.5 max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {filteredIndicators.map(ind => (
                    <label key={ind.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={indicatorIds.includes(ind.id)}
                        onChange={() => toggleIndicator(ind.id)}
                      />
                      <span>
                        <span className="font-semibold text-gray-700">{ind.indicator_code}</span>{' '}
                        <span className="text-[10px] text-gray-400">({ind.kind})</span>{' '}
                        <span className="text-gray-600">{ind.indicator_text}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {sourceMode === 'units' && (
              <>
                <label className={label}>หน่วยการเรียนรู้ (เลือก 1 หน่วย — ใช้ตัวชี้วัดที่ผูกไว้กับหน่วยนั้น)</label>
                <div className="mt-1.5 max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {units.map(u => (
                    <label key={u.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="radio" name="unit" className="mt-0.5"
                        checked={selectedUnitId === u.id}
                        onChange={() => selectUnit(u)}
                      />
                      <span className="min-w-0">
                        <span className="font-semibold text-gray-700">หน่วยที่ {u.seq}: {u.unit_name}</span>{' '}
                        <span className="text-[10px] text-gray-400">({u.weight}% · {u.hours} ชม.)</span>
                        {u.indicators.length > 0 ? (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {u.indicators.map(i => i.indicator_code).join(', ')}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 mt-0.5">ไม่มีตัวชี้วัดผูกไว้ — ใช้ชื่อหน่วยเป็นหัวข้อแทน</div>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {sourceMode === 'custom' && (
              <div className={field}>
                <label className={label}>หัวข้อ</label>
                <input
                  type="text" className={inputCls} value={customTopic}
                  onChange={e => setCustomTopic(e.target.value)}
                  placeholder="เช่น การเขียนโปรแกรมแบบวนซ้ำ (loop)"
                />
              </div>
            )}
          </div>
        )}

        {generateError && <div className="text-sm text-red-600 mt-3">{generateError}</div>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button" className={btn}
            disabled={!subjectId || generating || (indicatorIds.length === 0 && !customTopic.trim())}
            onClick={handleGenerate}
          >
            <SparkleIcon className="h-4 w-4" /> {generating ? 'กำลังสร้างข้อสอบ...' : 'สร้างข้อสอบด้วย AI'}
          </button>
          <button type="button" className={btnSecondary} disabled={!subjectId} onClick={handleAddManual}>
            <PencilIcon className="h-4 w-4" /> เพิ่มข้อสอบเอง
          </button>
        </div>
      </div>

      {draftQuestions.length > 0 && (
        <div className={card}>
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-gray-900">2. ตรวจทานร่างข้อสอบ ({draftQuestions.length} ข้อ)</div>
            <button type="button" className={btn} disabled={saving || hasIncompleteDraft} onClick={handleSaveAll}>
              <SaveIcon className="h-4 w-4" /> {saving ? 'กำลังบันทึก...' : 'บันทึกเข้าคลังทั้งหมด'}
            </button>
          </div>
          {hasIncompleteDraft && <div className="text-xs text-amber-600 mb-3">กรอกคำถามและตัวเลือกให้ครบทุกข้อก่อนบันทึก</div>}
          <div className="space-y-4">
            {draftQuestions.map((q, i) => (
              <div key={q._key} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-400">ข้อ {i + 1}</span>
                    <span className={pill + (q.source === 'manual' ? ' bg-purple-50 text-purple-700' : ' bg-indigo-50 text-indigo-700')}>
                      {SOURCE_LABEL[q.source] || SOURCE_LABEL.ai}
                    </span>
                  </div>
                  <button type="button" className={btnTiny} onClick={() => removeDraft(q._key)}>
                    <TrashIcon className="h-3.5 w-3.5" /> ลบข้อนี้
                  </button>
                </div>
                <textarea
                  className={inputCls + ' w-full mb-3'} rows={2}
                  value={q.question_text}
                  onChange={e => updateDraft(q._key, { question_text: e.target.value })}
                />
                <div className="space-y-1.5 mb-3">
                  {q.choices.map((c, ci) => (
                    <label key={ci} className="flex items-center gap-2">
                      <input
                        type="radio" name={`correct-${q._key}`}
                        checked={q.correct_choice === ci}
                        onChange={() => updateDraft(q._key, { correct_choice: ci })}
                      />
                      <input
                        type="text" className={inputCls + ' flex-1'}
                        value={c}
                        onChange={e => updateDraftChoice(q._key, ci, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <label className={label}>คำอธิบายเฉลย</label>
                <textarea
                  className={inputCls + ' w-full mt-1'} rows={2}
                  value={q.explanation}
                  onChange={e => updateDraft(q._key, { explanation: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={card}>
        <div className="font-semibold text-gray-900 mb-3">ข้อสอบที่บันทึกไว้แล้ว</div>
        {bankLoading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {!bankLoading && bankQuestions.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีข้อสอบในคลัง</div>}
        {bankQuestions.length > 0 && (
          <div className="max-h-[32rem] overflow-y-auto -mx-5 px-5">
            {groupBySubject(bankQuestions).map(group => {
              const expanded = expandedGroups.has(group.name);
              return (
                <div key={group.name}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.name)}
                    className="w-full flex items-center gap-2 pt-3 pb-1.5 first:pt-0 text-left"
                  >
                    <ChevronDownIcon className={"h-3.5 w-3.5 text-gray-400 shrink-0 transition-transform " + (expanded ? '' : '-rotate-90')} />
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{group.name}</span>
                    <span className="text-[11px] text-gray-400">({group.rows.length})</span>
                    <div className="h-px flex-1 bg-gray-100" />
                  </button>
                  {expanded && group.rows.map(q => (
                    <div key={q.id} className="flex justify-between items-start gap-3 text-sm py-2.5 border-b border-gray-100 last:border-b-0">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900">{q.question_text}</div>
                        <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span className={pill + (q.source === 'manual' ? ' bg-purple-50 text-purple-700' : ' bg-indigo-50 text-indigo-700')}>
                            {SOURCE_LABEL[q.source] || SOURCE_LABEL.ai}
                          </span>
                          <span className={pill + ' bg-amber-50 text-amber-700'}>{DIFFICULTIES.find(d => d.value === q.difficulty)?.label || q.difficulty}</span>
                          {q.indicators?.indicator_code && <span className={pill + ' bg-gray-100 text-gray-600'}>{q.indicators.indicator_code}</span>}
                          <span>{q.num_choices} ตัวเลือก</span>
                        </div>
                      </div>
                      <button className={btnTiny + ' shrink-0'} onClick={() => setDeleteTarget(q)}>
                        <TrashIcon className="h-3.5 w-3.5" /> ลบ
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="ยืนยันลบข้อสอบ"
        message={deleteTarget ? `ลบข้อสอบข้อนี้ออกจากคลัง?\n\n"${deleteTarget.question_text}"` : ''}
        confirmLabel="ลบข้อสอบ"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
