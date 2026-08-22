import "./globals.css";
import { AuthProvider } from "@/lib/AuthContext";

export const metadata = {
  title: "ระบบสอบวัดผล",
  description: "การสอบวัดผล — ระบบสร้างและตรวจกระดาษคำตอบ OMR",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th" className="h-full antialiased">
      <head>
        {/*
          Loaded by literal family name "Sarabun" (not next/font's obfuscated
          variable) because src/lib/omr-core.js and src/lib/exam-print.js
          draw canvases with ctx.font = '"Sarabun", sans-serif' directly —
          they need a font actually registered under that exact name, in the
          browser's font list, to pick it up instead of silently falling
          back.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&family=Noto+Serif+Thai:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col bg-gray-50 font-sans text-gray-900">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
