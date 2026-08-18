'use client';
// DashboardShell — the app chrome shared by every logged-in page: a
// hamburger-triggered sidebar (off-canvas on mobile, static on desktop)
// with the main menu, a top bar showing the signed-in user, and the page
// content in-between. Also acts as the auth gate: renders a login form
// until a Supabase session exists.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'แดชบอร์ด', icon: HomeIcon, adminOnly: false },
  { href: '/omr/prepare', label: 'เตรียมข้อสอบ', icon: SheetIcon, adminOnly: false },
  { href: '/omr/scan', label: 'สแกนตรวจ', icon: CameraIcon, adminOnly: false },
  { href: '/settings', label: 'ตั้งค่า', icon: GearIcon, adminOnly: true },
];

export default function DashboardShell({ children }) {
  const { session, isAdmin, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
        กำลังตรวจสอบสถานะเข้าสู่ระบบ...
      </div>
    );
  }

  if (!session) {
    return <LoginForm />;
  }

  const items = NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);

  return (
    <div className="flex flex-1 min-h-screen">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={
          "fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-gray-200 bg-white transform transition-transform duration-200 md:static md:translate-x-0 md:flex md:flex-col " +
          (sidebarOpen ? 'translate-x-0' : '-translate-x-full')
        }
      >
        <div className="flex items-center gap-2 px-5 h-16 border-b border-gray-200">
          <span className="text-lg font-bold text-gray-900">ระบบสอบวัดผล</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {items.map(item => (
            <NavLink key={item.href} {...item} onNavigate={() => setSidebarOpen(false)} />
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-gray-200 text-xs text-gray-500">
          เข้าสู่ระบบเป็น<br />
          <span className="font-medium text-gray-700">{session.user.email}</span>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 flex items-center gap-3 border-b border-gray-200 bg-white px-4 sticky top-0 z-20">
          <button
            type="button"
            aria-label="เปิด/ปิดเมนู"
            onClick={() => setSidebarOpen(v => !v)}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg text-gray-600 hover:bg-gray-100 md:hidden"
          >
            <HamburgerIcon />
          </button>
          <span className="font-semibold text-gray-800 md:hidden">ระบบสอบวัดผล</span>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="text-xs font-medium text-gray-600 border border-gray-300 rounded-md px-3 py-1.5 hover:bg-gray-50"
            >
              ออกจากระบบ
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

function NavLink({ href, label, icon: Icon, onNavigate }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors " +
        (active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-100')
      }
    >
      <Icon className={"h-5 w-5 " + (active ? 'text-indigo-600' : 'text-gray-400')} />
      {label}
    </Link>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    setSubmitting(false);
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-24">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-bold text-gray-900">เข้าสู่ระบบ</h1>
        <p className="mt-1 mb-6 text-sm text-gray-500">
          ใช้บัญชีครูของระบบ PP5 เพื่อจัดการกระดาษคำตอบ OMR
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email" required placeholder="อีเมล" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <input
            type="password" required placeholder="รหัสผ่าน" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          {error && <div className="text-xs text-red-600">{error}</div>}
          <button
            type="submit" disabled={submitting}
            className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    </div>
  );
}

function HamburgerIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function HomeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
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

function CameraIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
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
