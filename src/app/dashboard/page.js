'use client';

import Link from 'next/link';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';

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
      <p className="mt-1 text-sm text-gray-500">เลือกเมนูที่ต้องการใช้งาน</p>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
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
