'use client';
// AuthGate — wraps a page in a Supabase auth check. The OMR feature reads
// and writes tables scoped by RLS to `subjects.user_id = auth.uid()`, so it
// only works for a signed-in teacher; this renders a login form until a
// session exists, then renders `children`.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    setSubmitting(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  if (session === undefined) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#5b6370' }}>กำลังตรวจสอบสถานะเข้าสู่ระบบ...</div>;
  }

  if (!session) {
    return (
      <div style={{ maxWidth: 360, margin: '80px auto', padding: '0 16px', fontFamily: '"Prompt","Noto Sans Thai",sans-serif' }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>เข้าสู่ระบบ</h1>
        <div style={{ fontSize: 13, color: '#5b6370', marginBottom: 20 }}>
          ใช้บัญชีครูของระบบ PP5 เพื่อจัดการกระดาษคำตอบ OMR
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email" required placeholder="อีเมล" value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: '10px 12px', border: '1px solid #d5d9df', borderRadius: 8, fontSize: 14 }}
          />
          <input
            type="password" required placeholder="รหัสผ่าน" value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ padding: '10px 12px', border: '1px solid #d5d9df', borderRadius: 8, fontSize: 14 }}
          />
          {error && <div style={{ fontSize: 12, color: '#c0362c' }}>{error}</div>}
          <button
            type="submit" disabled={submitting}
            style={{ background: 'linear-gradient(135deg,#6a5cff,#3aa0ff)', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14, opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: '10px 16px', fontSize: 12, color: '#5b6370', fontFamily: '"Prompt","Noto Sans Thai",sans-serif' }}>
        <span>{session.user.email}</span>
        <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid #d5d9df', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
          ออกจากระบบ
        </button>
      </div>
      {children}
    </div>
  );
}
