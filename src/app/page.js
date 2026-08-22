import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-gray-50 font-prompt">
      <main className="flex w-full max-w-xl flex-col items-center gap-6 px-6 py-32 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          ระบบสอบวัดผล
        </h1>
        <p className="text-gray-500">
          จัดการข้อสอบ สอบออนไลน์ และตรวจกระดาษคำตอบ OMR อัตโนมัติ
        </p>
        <Link
          href="/dashboard"
          className="flex h-12 items-center justify-center rounded-full bg-gradient-to-r from-indigo-600 to-blue-500 px-8 font-medium text-white transition hover:opacity-90"
        >
          เข้าสู่ระบบ
        </Link>
      </main>
    </div>
  );
}
