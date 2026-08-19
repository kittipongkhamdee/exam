'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { listMyQuizzes, listMyRecentScanActivity, getMyScanStats } from '@/lib/omr-db';

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5';

function scoreColor(pct) {
  if (pct >= 80) return 'text-green-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function formatThaiDate(d) {
  return new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

function formatThaiTime(d) {
  return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' น.';
}

function GreetingBanner() {
  const { session, isAdmin, fullName } = useAuth();
  // Rendered on mount only (not during the static prerender) so the date/
  // time in the banner never bakes a stale build-time value into the HTML
  // and then mismatches the client's actual clock on hydration.
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="rounded-2xl bg-gradient-to-br from-indigo-600 via-purple-600 to-blue-500 text-white p-5 sm:p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-11 w-11 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
          <CapIcon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-lg truncate">สวัสดี, {fullName || session?.user?.email}</div>
          <div className="text-sm text-white/80">{isAdmin ? 'ผู้ดูแลระบบ' : 'ครูผู้สอน'}</div>
        </div>
      </div>
      {now && (
        <div>
          <div className="text-sm text-white/90">{formatThaiDate(now)}</div>
          <div className="text-2xl font-extrabold mt-0.5">{formatThaiTime(now)}</div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, iconBg, value, unit, label }) {
  return (
    <div className={card}>
      <div className="flex items-center gap-2 mb-2">
        <div className={"h-9 w-9 rounded-lg flex items-center justify-center shrink-0 text-white " + iconBg}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-xs text-gray-500 truncate">{label}</div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-extrabold text-gray-900">{value === null ? '-' : value}</span>
        <span className="text-xs text-gray-400">{unit}</span>
      </div>
    </div>
  );
}

function ShortcutRow({ href, icon: Icon, iconBg, title, desc }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 -mx-2 px-2 py-2.5 rounded-lg hover:bg-gray-50 transition"
    >
      <div className={"h-11 w-11 rounded-xl flex items-center justify-center shrink-0 text-white " + iconBg}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-gray-900">{title}</div>
        <div className="text-xs text-gray-500 truncate">{desc}</div>
      </div>
      <ChevronRightIcon className="h-4 w-4 text-gray-300 shrink-0" />
    </Link>
  );
}

function ShortcutsCard() {
  const { isAdmin } = useAuth();
  return (
    <div className={card + ' mb-6'}>
      <div className="text-sm font-bold mb-1">⚡ ทางลัด</div>
      <div className="divide-y divide-gray-100">
        <ShortcutRow href="/omr/prepare" icon={SheetIcon} iconBg="bg-gradient-to-br from-indigo-600 to-blue-500" title="กระดาษคำตอบ" desc="สร้างชุดข้อสอบและคีย์เฉลย" />
        <ShortcutRow href="/omr/scan" icon={CameraIcon} iconBg="bg-gradient-to-br from-emerald-600 to-teal-500" title="สแกนตรวจข้อสอบ" desc="ใช้กล้องมือถือตรวจอัตโนมัติ" />
        <ShortcutRow href="/omr/report" icon={ReportIcon} iconBg="bg-gradient-to-br from-amber-500 to-orange-500" title="รายงานคะแนน" desc="ดูสถิติและส่งออก CSV" />
        {isAdmin && (
          <ShortcutRow href="/settings" icon={GearIcon} iconBg="bg-gradient-to-br from-slate-700 to-slate-500" title="ตั้งค่า" desc="การตั้งค่าระบบสำหรับผู้ดูแล" />
        )}
      </div>
    </div>
  );
}

function ActivityPanel() {
  const [data, setData] = useState(null); // { totalQuizzes, totalScanned, avgScore, notYetScanned, recent }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [quizzes, scanStats, recent] = await Promise.all([
          listMyQuizzes(supabase),
          getMyScanStats(supabase),
          listMyRecentScanActivity(supabase, 5),
        ]);
        setData({
          totalQuizzes: quizzes.length,
          totalScanned: scanStats.totalScanned,
          avgScore: scanStats.avgScore,
          notYetScanned: Math.max(0, quizzes.length - scanStats.scannedQuizIds.size),
          recent,
        });
      } catch {
        // best-effort — the greeting banner and shortcuts above still work
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-500 mb-6">กำลังโหลดข้อมูล...</div>;
  }
  if (!data) return null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard icon={SheetIcon} iconBg="bg-gradient-to-br from-indigo-600 to-blue-500" value={data.totalQuizzes} unit="ชุด" label="กระดาษคำตอบ" />
        <StatCard icon={CheckSheetIcon} iconBg="bg-gradient-to-br from-emerald-600 to-teal-500" value={data.totalScanned} unit="ใบ" label="ตรวจแล้ว" />
        <StatCard icon={PercentIcon} iconBg="bg-gradient-to-br from-amber-500 to-orange-500" value={data.avgScore} unit="%" label="คะแนนเฉลี่ย" />
        <StatCard icon={AlertIcon} iconBg="bg-gradient-to-br from-cyan-600 to-sky-500" value={data.notYetScanned} unit="ชุด" label="ยังไม่ได้ตรวจ" />
      </div>

      <div className={card}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 text-sm font-bold">
            <ClockIcon className="h-4 w-4 text-gray-400" /> ผลการตรวจล่าสุด
          </div>
          <Link href="/omr/report" className="text-xs font-semibold text-indigo-600 flex items-center gap-0.5">
            ดูทั้งหมด <ChevronRightIcon className="h-3.5 w-3.5" />
          </Link>
        </div>

        {data.recent.length === 0 ? (
          <div className="flex flex-col items-center text-center py-6">
            <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <InfoIcon className="h-5 w-5 text-gray-400" />
            </div>
            <div className="text-sm text-gray-500 mb-4">ยังไม่มีการตรวจข้อสอบ</div>
            <Link
              href="/omr/prepare"
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-blue-500 text-white text-sm font-semibold px-4 py-2.5 hover:opacity-90 transition"
            >
              <PlusIcon className="h-4 w-4" /> สร้างกระดาษคำตอบชุดแรก
            </Link>
          </div>
        ) : (
          <div className="space-y-1">
            {data.recent.map(r => (
              <Link
                key={r.id}
                href={`/omr/report?quizId=${r.omr_quizzes?.id}`}
                className="flex items-center justify-between gap-3 -mx-2 px-2 py-2 rounded-lg hover:bg-gray-50 transition"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {r.students?.prefix}{r.students?.student_name}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {r.omr_quizzes?.title} · {r.omr_quizzes?.subjects?.subject_name} ({r.omr_quizzes?.subjects?.grade_level}/{r.omr_quizzes?.subjects?.room})
                  </div>
                </div>
                <div className={"text-sm font-bold shrink-0 " + scoreColor(r.score)}>{r.score}%</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function DashboardContent() {
  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">แดชบอร์ด</h1>
          <p className="mt-1 text-sm text-gray-500">ภาพรวมการตรวจข้อสอบของคุณ</p>
        </div>
        <Link
          href="/omr/scan"
          aria-label="สแกนตรวจข้อสอบ"
          className="h-11 w-11 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-500 text-white flex items-center justify-center shrink-0 shadow-md shadow-indigo-200 hover:opacity-90 transition"
        >
          <CameraIcon className="h-5 w-5" />
        </Link>
      </div>

      <GreetingBanner />
      <ShortcutsCard />
      <ActivityPanel />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <DashboardShell>
      <DashboardContent />
    </DashboardShell>
  );
}

function CapIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m2 9 10-5 10 5-10 5-10-5Z" />
      <path d="M6 11v5c0 1.5 2.5 3 6 3s6-1.5 6-3v-5" />
    </svg>
  );
}

function SheetIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function CheckSheetIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="m9 13 2 2 4-4" />
    </svg>
  );
}

function PercentIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  );
}

function AlertIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17.5v.01" />
    </svg>
  );
}

function CameraIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function ReportIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
    </svg>
  );
}

function GearIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

function ChevronRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ClockIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function InfoIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.01" />
    </svg>
  );
}

function PlusIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
