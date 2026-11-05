import { useState } from 'react';

import { supabase } from './supabaseClient';

const DEMO_ACCOUNTS = [
  { label: 'Client A', email: 'client-a@example.com' },
  { label: 'Client B', email: 'client-b@example.com' },
];

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

type FieldState = 'idle' | 'valid' | 'invalid';

function FieldIcon({ state }: { state: FieldState }) {
  if (state === 'valid')
    return <span className="field-icon valid" aria-hidden="true">✓</span>;
  if (state === 'invalid')
    return <span className="field-icon invalid" aria-hidden="true">✕</span>;
  return null;
}

const SEED_PASSWORD = import.meta.env.VITE_SEED_PASSWORD ?? 'TestAccess!234';

export function Login() {
  const [email, setEmail] = useState('client-a@example.com');
  const [password, setPassword] = useState(SEED_PASSWORD);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  const emailState: FieldState = !emailTouched ? 'idle' : isValidEmail(email) ? 'valid' : 'invalid';
  const passwordState: FieldState = !passwordTouched ? 'idle' : password.length >= 6 ? 'valid' : 'invalid';

  async function signIn(nextEmail: string, nextPassword: string) {
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: nextEmail,
      password: nextPassword,
    });
    if (signInError) {
      setError(`Sign in failed: ${signInError.message}`);
      setBusy(false);
    } else {
      setSuccess(true);
      // App.tsx will transition once the session event fires
    }
  }

  return (
    <main className="page narrow">
      <div className={`login-card${success ? ' login-card--success' : ''}`}>
        <h1>Paid Client Access</h1>
        <p className="muted">Demo portal. Sign in with one of the seeded test clients.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setEmailTouched(true);
            setPasswordTouched(true);
            if (!isValidEmail(email) || password.length < 6) return;
            void signIn(email, password);
          }}
        >
          <label>
            Email
            <div className="input-wrap">
              <input
                value={email}
                onChange={(e) => { setEmail(e.target.value); setEmailTouched(true); }}
                onBlur={() => setEmailTouched(true)}
                type="email"
                autoComplete="username"
                className={emailState !== 'idle' ? `input-${emailState}` : ''}
                aria-invalid={emailState === 'invalid'}
              />
              <FieldIcon state={emailState} />
            </div>
            {emailState === 'invalid' && <span className="field-error">Enter a valid email address</span>}
          </label>

          <label>
            Password
            <div className="input-wrap">
              <input
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordTouched(true); }}
                onBlur={() => setPasswordTouched(true)}
                type="password"
                autoComplete="current-password"
                className={passwordState !== 'idle' ? `input-${passwordState}` : ''}
                aria-invalid={passwordState === 'invalid'}
              />
              <FieldIcon state={passwordState} />
            </div>
            {passwordState === 'invalid' && <span className="field-error">Password must be at least 6 characters</span>}
          </label>

          <button type="submit" disabled={busy || !email || !password} className={busy ? 'btn-loading' : ''}>
            {busy ? <><span className="spinner" aria-hidden="true" /> Signing in...</> : success ? '✓ Signed in' : 'Sign in'}
          </button>
        </form>

        {error && <p className="error anim-shake">{error}</p>}

        <div className="hint">
          <p>
            Both accounts share the password from <code>SEED_CLIENT_PASSWORD</code>. Use them to show isolation:
            whatever Client A buys, Client B can never read.
          </p>
          <div className="row">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className={`ghost${email === account.email ? ' active' : ''}`}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(SEED_PASSWORD);
                  setEmailTouched(true);
                  setPasswordTouched(true);
                }}
              >
                Use {account.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
