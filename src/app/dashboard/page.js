'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { listMyQuizzes, listMyRecentScanActivity, countScanResultsSince } from '@/lib/omr-db';

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5';
const stat = 'text-center p-3 rounded-lg bg-gray-50';
const statN = 'text-xl font-extrabold text-gray-900';
const statL = 'text-[11px] text-gray-500';

function scoreColor(pct) {
  if (pct >= 80) return 'text-green-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function StatsPanel() {
  const [stats, setStats] = useState(null); // { totalQuizzes, scannedToday, scannedWeek }
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const [quizzes, recentActivity, scannedToday, scannedWeek] = await Promise.all([
          listMyQuizzes(supabase),
          listMyRecentScanActivity(supabase, 5),
          countScanResultsSince(supabase, startOfToday),
          countScanResultsSince(supabase, startOfWeek),
        ]);
        setStats({ totalQuizzes: quizzes.length, scannedToday, scannedWeek });
        setRecent(recentActivity);
      } catch {
        // best-effort — the menu cards below still work without this panel
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-500 mb-6">กำลังโหลดสรุปกิจกรรม...</div>;
  }
  if (!stats) return null;

  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className={stat}>
          <div className={statN}>{stats.totalQuizzes}</div>
          <div className={statL}>ชุดข้อสอบทั้งหมด</div>
        </div>
        <div className={stat}>
          <div className={statN}>{stats.scannedToday}</div>
          <div className={statL}>สแกนวันนี้</div>
        </div>
        <div className={stat}>
          <div className={statN}>{stats.scannedWeek}</div>
          <div className={statL}>สแกน 7 วันที่ผ่านมา</div>
        </div>
      </div>

      {recent.length > 0 && (
        <div className={card}>
          <div className="text-sm font-bold mb-3">กิจกรรมล่าสุด</div>
          <div className="space-y-1">
            {recent.map(r => (
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
        </div>
      )}
    </div>
  );
}

function DashboardContent() {
  const { isAdmin } = useAuth();

  const cards = [
    {
      href: '/omr/prepare',
      title: 'เตรียมข้อสอบ',
      desc: 'เลือกวิชา ออกแบบกระดาษคำตอบ และกำหนดเฉลย (ทำล่วงหน้าบนคอมพิวเตอร์)',
      accent: 'from-indigo-600 to-blue-500',
    },
    {
      href: '/omr/scan',
      title: 'สแกนตรวจ',
      desc: 'สแกนกระดาษคำตอบของนักเรียนด้วยมือถือหลังสอบเสร็จ',
      accent: 'from-emerald-600 to-teal-500',
    },
    {
      href: '/omr/report',
      title: 'รายงาน',
      desc: 'ดูคะแนนและสถิติของนักเรียนที่สแกนแล้ว',
      accent: 'from-amber-500 to-orange-500',
    },
    ...(isAdmin
      ? [{
          href: '/settings',
          title: 'ตั้งค่า',
          desc: 'การตั้งค่าระบบสำหรับผู้ดูแล',
          accent: 'from-slate-700 to-slate-500',
        }]
      : []),
  ];

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-gray-900">แดชบอร์ด</h1>
      <p className="mt-1 text-sm text-gray-500 mb-6">เลือกเมนูที่ต้องการใช้งาน</p>

      <StatsPanel />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map(c => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-xl border border-gray-200 bg-white p-5 hover:shadow-md hover:border-gray-300 transition"
          >
            <div className={`h-10 w-10 rounded-lg bg-gradient-to-br ${c.accent} mb-4`} />
            <div className="font-semibold text-gray-900 group-hover:text-indigo-700">{c.title}</div>
            <div className="mt-1 text-sm text-gray-500">{c.desc}</div>
          </Link>
        ))}
      </div>
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
