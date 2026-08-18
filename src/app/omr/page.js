import AuthGate from '@/components/AuthGate';
import OMRAnswerSheetTool from '@/components/OMRAnswerSheetTool';

export default function OMRPage() {
  return (
    <AuthGate>
      <OMRAnswerSheetTool />
    </AuthGate>
  );
}
