'use client';
// AuthContext — tracks the Supabase session and whether the signed-in user
// is an admin (profiles.is_admin), shared across the dashboard shell and
// any page that needs to gate content by role (e.g. /settings).

import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadProfile(sess) {
      if (!sess) { setIsAdmin(false); return; }
      const { data } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', sess.user.id)
        .maybeSingle();
      if (active) setIsAdmin(!!data?.is_admin);
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

  return (
    <AuthContext.Provider value={{ session, isAdmin, loading: session === undefined }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
