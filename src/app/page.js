import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-xl flex-col items-center gap-6 px-6 py-32 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          ระบบสอบวัดผล
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          สร้างและตรวจกระดาษคำตอบ OMR อัตโนมัติ
        </p>
        <Link
          href="/omr"
          className="flex h-12 items-center justify-center rounded-full bg-foreground px-6 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          ไปที่เครื่องมือ OMR
        </Link>
      </main>
    </div>
  );
}
