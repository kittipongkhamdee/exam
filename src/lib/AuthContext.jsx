'use client';
// AuthContext — tracks the Supabase session and profile-derived settings
// (is_admin, full_name, save_scan_photos) shared across the dashboard
// shell and any page that needs to read/change them (e.g. /settings, the
// scan tool, the dashboard's greeting banner).

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [isAdmin, setIsAdmin] = useState(false);
  const [fullName, setFullName] = useState('');
  const [saveScanPhotos, setSaveScanPhotosState] = useState(false);

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
      loadProfile(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      loadProfile(sess);
    });

    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

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
    <AuthContext.Provider value={{ session, isAdmin, fullName, saveScanPhotos, setSaveScanPhotos, loading: session === undefined }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
