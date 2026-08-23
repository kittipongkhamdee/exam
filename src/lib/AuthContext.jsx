'use client';
// AuthContext — tracks the Supabase session and profile-derived settings
// (is_admin, full_name, save_scan_photos) shared across the dashboard
// shell and any page that needs to read/change them (e.g. /settings, the
// scan tool, the dashboard's greeting banner).

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './supabaseClient';

const AuthContext = createContext(null);

// Auto sign-out after this long with no keyboard/mouse/touch/scroll
// activity — a teacher's dashboard tab left open (school computer,
// shared/public device) shouldn't stay signed in indefinitely. Doesn't
// apply to /take: students never get a Supabase session (PIN-based, no
// `session` here to trigger this effect), so this only ever affects the
// teacher/admin dashboard.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'];

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [isAdmin, setIsAdmin] = useState(false);
  const [fullName, setFullName] = useState('');
  const [saveScanPhotos, setSaveScanPhotosState] = useState(false);
  // Set right before the idle timer signs the user out, so the login
  // screen that appears next can explain why — cleared again the moment
  // a session exists (a fresh sign-in, idle or not).
  const [idleSignedOut, setIdleSignedOut] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadProfile(sess) {
      if (!sess) { setIsAdmin(false); setFullName(''); setSaveScanPhotosState(false); return; }
      const { data } = await supabase
        .from('profiles')
        .select('is_admin, save_scan_photos, full_name')
        .eq('id', sess.user.id)
        .maybeSingle();
      if (!active) return;
      setIsAdmin(!!data?.is_admin);
      setFullName(data?.full_name || '');
      setSaveScanPhotosState(!!data?.save_scan_photos);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) setIdleSignedOut(false);
      loadProfile(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (sess) setIdleSignedOut(false);
      loadProfile(sess);
    });

    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    let timer;
    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setIdleSignedOut(true);
        supabase.auth.signOut();
      }, IDLE_TIMEOUT_MS);
    }
    resetTimer();
    for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, resetTimer, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, resetTimer);
    };
  }, [session]);

  const setSaveScanPhotos = useCallback(async (value) => {
    if (!session) return;
    setSaveScanPhotosState(value); // optimistic
    const { error } = await supabase
      .from('profiles')
      .update({ save_scan_photos: value })
      .eq('id', session.user.id);
    if (error) { setSaveScanPhotosState(!value); throw error; }
  }, [session]);

  return (
    <AuthContext.Provider value={{ session, isAdmin, fullName, saveScanPhotos, setSaveScanPhotos, idleSignedOut, loading: session === undefined }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
