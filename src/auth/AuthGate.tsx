import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import SignIn from './SignIn';
import MfaEnroll from './MfaEnroll';
import MfaChallenge from './MfaChallenge';

// Where the signed-in user is on the way to the app:
//   signed-out  → email + password
//   enroll      → signed in, but no authenticator set up yet (first time)
//   challenge   → signed in, has an authenticator, hasn't entered today's code
//   ready       → passed 2FA (session is 'aal2'); RLS will now return data
type Stage = 'loading' | 'signed-out' | 'enroll' | 'challenge' | 'ready';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('loading');

  const evaluate = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return setStage('signed-out');

    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return setStage('signed-out');

    if (data.currentLevel === 'aal2') setStage('ready');
    else if (data.nextLevel === 'aal2') setStage('challenge');
    else setStage('enroll');
  }, []);

  useEffect(() => {
    evaluate();
    // Don't await Supabase calls inside this callback — it can deadlock the
    // auth client. Defer to the next tick instead.
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      setTimeout(evaluate, 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [evaluate]);

  switch (stage) {
    case 'loading':    return <div className="center muted">Loading…</div>;
    case 'signed-out': return <SignIn />;
    case 'enroll':     return <MfaEnroll onDone={evaluate} />;
    case 'challenge':  return <MfaChallenge onDone={evaluate} />;
    case 'ready':      return <>{children}</>;
  }
}
