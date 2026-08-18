# exam

การสอบวัดผล — ระบบสร้าง/ตรวจกระดาษคำตอบ OMR (Optical Mark Recognition) บน Next.js

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser, then go to
[http://localhost:3000/omr](http://localhost:3000/omr) for the OMR answer sheet tool.

### Environment variables

Copy `.env.example` to `.env.local` and fill in the Supabase project credentials
(project **PP5**, `zwtulepvmlngcrbcrrki`):

```bash
cp .env.example .env.local
```

## OMR Answer Sheet Tool

- Generates a printable A4 answer sheet (cut into two half-height sheets) with
  corner markers, a student-ID grid, and a multi-column question grid.
- Scans a photographed sheet client-side (camera or file upload): detects the
  corner markers, perspective-corrects the image, reads bubble darkness, and
  grades against a teacher-set answer key.
- Quizzes, answer keys, and scan results are persisted to Supabase
  (`omr_quizzes`, `omr_answer_keys`, `omr_scan_results`), scoped to the
  teacher's subject via `subjects.user_id = auth.uid()`.

See `src/lib/omr-core.js` (pure OMR logic), `src/lib/omr-db.js` (Supabase
queries), and `src/components/OMRAnswerSheetTool.jsx` (the generator/scanner
UI) for details.
