import { useState } from 'react';

import { supabase } from './supabaseClient';

const DEMO_ACCOUNTS = [
  { label: 'Client A', email: 'client-a@example.com' },
  { label: 'Client B', email: 'client-b@example.com' },
];

export function Login() {
  const [email, setEmail] = useState('client-a@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(nextEmail: string, nextPassword: string) {
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: nextEmail,
      password: nextPassword,
    });
    if (signInError) setError(`Sign in failed: ${signInError.message}`);
    setBusy(false);
  }

  return (
    <main className="page narrow">
      <h1>Paid Client Access</h1>
      <p className="muted">Demo portal. Sign in with one of the seeded test clients.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(email, password);
        }}
      >
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>
        <button type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      <div className="hint">
        <p>
          Both accounts share the password from <code>SEED_CLIENT_PASSWORD</code>. Use them to show isolation:
          whatever Client A buys, Client B can never read.
        </p>
        <div className="row">
          {DEMO_ACCOUNTS.map((account) => (
            <button key={account.email} type="button" className="ghost" onClick={() => setEmail(account.email)}>
              Use {account.label}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
