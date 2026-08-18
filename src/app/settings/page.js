'use client';

import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';

function SettingsContent() {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-5">
        <div className="font-semibold text-red-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</div>
        <div className="mt-1 text-sm text-red-600">เมนูตั้งค่าใช้ได้เฉพาะผู้ดูแลระบบ (แอดมิน) เท่านั้น</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900">ตั้งค่าระบบ</h1>
      <p className="mt-1 text-sm text-gray-500">สำหรับผู้ดูแลระบบเท่านั้น</p>

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
        <div className="font-semibold text-gray-900">กำลังพัฒนา</div>
        <p className="mt-1 text-sm text-gray-500">
          ส่วนนี้เป็นจุดเริ่มต้นสำหรับเมนูตั้งค่า — ยังไม่มีการตั้งค่าให้ปรับตอนนี้
          บอกได้เลยว่าต้องการให้เพิ่มการตั้งค่าอะไร เช่น ข้อมูลโรงเรียน จัดการผู้ใช้ หรือสิทธิ์การเข้าถึง
        </p>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <DashboardShell>
      <SettingsContent />
    </DashboardShell>
  );
}
