'use client';
// ConfirmDialog.jsx
//
// A stand-in for window.confirm() backed by SweetAlert2 instead of the
// browser's native (and jarringly unstyled) confirm popup. Fully
// controlled, same external API as before this used SweetAlert2 (open,
// title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel)
// so no call site needs to change — this just fires Swal.fire() when
// `open` flips true. `loading` is accepted but unused: Swal now owns its
// own in-dialog loading state via showLoaderOnConfirm, since preConfirm
// awaits onConfirm directly.

import { useEffect, useRef } from 'react';
import Swal from 'sweetalert2';

export default function ConfirmDialog({
  open, title, message, confirmLabel = 'ยืนยัน', cancelLabel = 'ยกเลิก',
  danger = false, onConfirm, onCancel,
}) {
  const isOpenRef = useRef(false);

  useEffect(() => {
    if (open && !isOpenRef.current) {
      isOpenRef.current = true;
      Swal.fire({
        title,
        text: message,
        icon: danger ? 'warning' : 'question',
        showCancelButton: true,
        confirmButtonText: confirmLabel,
        cancelButtonText: cancelLabel,
        confirmButtonColor: danger ? '#dc2626' : '#4f46e5',
        cancelButtonColor: '#6b7280',
        reverseButtons: true,
        showLoaderOnConfirm: true,
        allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async () => {
          try {
            if (onConfirm) await onConfirm();
          } catch (err) {
            // SweetAlert2 silently swallows a rejected preConfirm by
            // default — it just stops the loading spinner and leaves the
            // dialog open with no explanation, which read as "the delete
            // button did nothing" to whoever clicked it. Every ConfirmDialog
            // caller (delete flows across the app) gets a real error message
            // here instead, with no per-caller try/catch needed.
            Swal.showValidationMessage(err?.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
            return false;
          }
        },
      }).then(result => {
        isOpenRef.current = false;
        if (!result.isConfirmed && onCancel) onCancel();
      });
    } else if (!open) {
      isOpenRef.current = false;
    }
    // Fires once per open->true transition — title/message/etc are only
    // read at that instant, matching the old modal's behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return null;
}
