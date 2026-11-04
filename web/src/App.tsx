import type { Session } from '@supabase/supabase-js';

import { Portal } from './Portal';
import { Login } from './Login';
import { supabase } from './supabaseClient';
import { useEffect, useState } from 'react';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="page">Loading session...</main>;
  if (!session) return <Login />;
  return <Portal email={session.user.email ?? ''} />;
}
