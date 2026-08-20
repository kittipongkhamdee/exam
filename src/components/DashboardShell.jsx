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

const NAV_GROUPS = [
  {
    items: [
      { href: '/dashboard', label: 'แดชบอร์ด', icon: HomeIcon, adminOnly: false },
    ],
  },
  {
    label: 'กระดาษคำตอบ',
    items: [
      { href: '/omr/prepare', label: 'กระดาษคำตอบ', icon: SheetIcon, adminOnly: false },
      { href: '/omr/scan', label: 'สแกนตรวจ', icon: CameraIcon, adminOnly: false },
      { href: '/omr/report', label: 'รายงาน', icon: ReportIcon, adminOnly: false },
    ],
  },
  {
    label: 'สอบออนไลน์',
    items: [
      { label: 'คลังข้อสอบ', icon: BankIcon, adminOnly: false, comingSoon: true },
      { label: 'ข้อสอบ', icon: SheetIcon, adminOnly: false, comingSoon: true },
      { label: 'จัดสอบ', icon: ClipboardIcon, adminOnly: false, comingSoon: true },
      { label: 'รายงาน', icon: ReportIcon, adminOnly: false, comingSoon: true },
    ],
  },
  {
    items: [
      { href: '/settings', label: 'ตั้งค่า', icon: GearIcon, adminOnly: true },
    ],
  },
];

export default function DashboardShell({ children }) {
  const { session, isAdmin, loading } = useAuth();
  // Two independent toggles driven by one hamburger button: below the `md`
  // breakpoint the sidebar is an off-canvas drawer (mobileOpen, closed by
  // default so it doesn't block the screen on load); at `md` and above it's
  // part of the static layout and the button instead collapses its width to
  // 0 (desktopCollapsed) to hand that space back to the page content — a
  // plain translate-based drawer wouldn't reclaim any width there since the
  // sidebar isn't overlaying anything to begin with.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);

  function toggleSidebar() {
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
      setDesktopCollapsed(v => !v);
    } else {
      setMobileOpen(v => !v);
    }
  }

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

  const groups = NAV_GROUPS
    .map(group => ({ ...group, items: group.items.filter(item => !item.adminOnly || isAdmin) }))
    .filter(group => group.items.length > 0);

  return (
    <div className="flex flex-1 min-h-screen">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={
          "fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-gray-200 bg-white transform transition-[transform,width] duration-200 md:static md:translate-x-0 md:flex md:flex-col md:overflow-hidden " +
          (mobileOpen ? 'translate-x-0' : '-translate-x-full') + ' ' +
          (desktopCollapsed ? 'md:w-0 md:border-r-0' : 'md:w-64')
        }
      >
        <div className="w-64 h-full flex flex-col">
          <div className="flex items-center gap-2 px-5 h-16 border-b border-gray-200">
            <span className="text-lg font-bold text-gray-900">ระบบสอบวัดผล</span>
          </div>
          <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
            {groups.map((group, i) => (
              <div key={group.label || i}>
                {group.label && (
                  <div className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {group.label}
                  </div>
                )}
                <div className="space-y-1">
                  {group.items.map(item => (
                    <NavLink key={item.href || item.label} {...item} onNavigate={() => setMobileOpen(false)} />
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="px-3 py-4 border-t border-gray-200 text-xs text-gray-500">
            เข้าสู่ระบบเป็น<br />
            <span className="font-medium text-gray-700">{session.user.email}</span>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 flex items-center gap-3 border-b border-gray-200 bg-white px-4 sticky top-0 z-20">
          <button
            type="button"
            aria-label="เปิด/ปิดเมนู"
            onClick={toggleSidebar}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg text-gray-600 hover:bg-gray-100 shrink-0"
          >
            <HamburgerIcon />
          </button>
          <span className={"font-semibold text-gray-800 " + (desktopCollapsed ? '' : 'md:hidden')}>ระบบสอบวัดผล</span>
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

function NavLink({ href, label, icon: Icon, onNavigate, comingSoon }) {
  const pathname = usePathname();
  const active = pathname === href;

  if (comingSoon) {
    return (
      <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-400 cursor-default">
        <Icon className="h-5 w-5 text-gray-300" />
        <span className="flex-1">{label}</span>
        <span className="text-[10px] font-semibold bg-gray-100 text-gray-400 rounded px-1.5 py-0.5">เร็วๆ นี้</span>
      </div>
    );
  }

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
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-400 flex items-center justify-center shadow-lg shadow-indigo-200 mb-4">
            <ScanCheckIcon className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">ระบบสอบวัดผล</h1>
          <p className="mt-1 text-sm text-gray-500">เข้าสู่ระบบเพื่อจัดการและตรวจข้อสอบ</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">อีเมล</label>
              <div className="relative">
                <MailIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="email" required placeholder="อีเมลของคุณ" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">รหัสผ่าน</label>
              <div className="relative">
                <LockIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="password" required placeholder="รหัสผ่าน" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <button
              type="submit" disabled={submitting}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'กำลังเข้าสู่ระบบ...' : (<><ArrowRightIcon className="h-4 w-4" /> เข้าสู่ระบบ</>)}
            </button>
          </form>
        </div>

        <div className="mt-6 flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/promptpay-qr.jpg" alt="PromptPay QR" className="h-20 w-20 rounded-lg object-cover shrink-0 border border-gray-100" />
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-600">
              ☕ เลี้ยงกาแฟผู้พัฒนา
            </div>
            <div className="text-sm font-bold text-gray-900">085-203-7897</div>
            <div className="text-xs text-gray-500">นายกิตติพงษ์ คำดี</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanCheckIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function MailIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function LockIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ArrowRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
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

function ReportIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
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

function ClipboardIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" />
      <path d="M9 12h6M9 16h4" />
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
