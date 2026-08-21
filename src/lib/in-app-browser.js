// in-app-browser.js
//
// Detects known in-app WebViews (LINE, Facebook/Messenger, Instagram,
// WeChat, TikTok, and a generic Android WebView fallback) via the user
// agent string. These embedded browsers are frequently missing or
// unreliable on things the exam-taking flow depends on — persistent
// localStorage across app-switches (breaks the refresh-resume session),
// the Fullscreen API, and in practice they're the browsers where a
// teacher's "ปลดล็อกผ่านจอมอนิเตอร์" (unlock from the live monitor) most
// often doesn't visibly unstick the student, since the app can fully
// discard and reload the page state on backgrounding. User-agent sniffing
// is inherently a heuristic (strings can be spoofed or change), but it's
// the only signal available here — good enough to steer the common case
// (a student tapping an exam link shared inside LINE/Messenger) toward a
// real browser before they start.
export function detectInAppBrowser() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  if (/BytedanceWebview|TikTok/i.test(ua)) return 'TikTok';
  if (/; ?wv\)/i.test(ua)) return 'แอปนี้';
  return null;
}
