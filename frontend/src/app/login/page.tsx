"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Logo } from "@/components/AppShell";
import OtpInput from "@/components/OtpInput";
import { AUTH_ENABLED, authMismatch, getSupabase, safeNextPath, signOutLocal, takeAuthError, useAuth } from "@/lib/auth";
import { api, ApiError, errorMessage, useApi } from "@/lib/api";
import { prefersReducedMotion } from "@/lib/motion";
import type { Health } from "@/lib/types";

type Method = "password" | "code";
type Intent = "signin" | "signup";
/** Which email code we're waiting for: account confirmation, or a passwordless sign-in. */
type OtpKind = "signup" | "email";

/** Must match Authentication → Providers → Email → "Email OTP Length" in Supabase. */
const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

/** Supabase auth errors carry a `code`; older SDK paths only have the message. */
function authError(err: unknown): string {
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const msg = errorMessage(err, "Something went wrong").toLowerCase();
  if (code === "otp_expired" || msg.includes("expired")) return "That code has expired or isn't right. Check the latest email, or tap Resend for a new one.";
  if (code === "over_email_send_rate_limit" || msg.includes("rate limit") || msg.includes("security purposes"))
    return "Too many emails were sent just now. Wait a minute, then try again.";
  if (code === "email_not_confirmed") return "This email isn't verified yet.";
  if (code === "invalid_credentials") return "Email or password is incorrect.";
  if (code === "weak_password") return "Choose a stronger password: at least 8 characters.";
  return errorMessage(err, "Sign-in failed");
}

/** Animated tick shown once the server accepts the new session, just before we leave /login. */
function Welcome({ firstTime, email }: { firstTime: boolean; email: string | null }) {
  return (
    <div className="auth-success flex flex-col items-center text-center py-4" role="status">
      <svg className="auth-success-tick" viewBox="0 0 96 96" width="96" height="96" aria-hidden>
        <circle className="auth-success-ring" cx="48" cy="48" r="42" />
        <path className="auth-success-check" d="M30 49 L43 62 L67 36" />
      </svg>
      <h1 className="auth-success-title text-[30px] leading-[36px] mt-6">{firstTime ? "You're all set!" : "Welcome back!"}</h1>
      <p className="auth-success-sub text-[15px] mt-2 text-ink/80">
        {firstTime
          ? `Your account${email ? ` for ${email}` : ""} is verified.`
          : `Signed in${email ? ` as ${email}` : ""}.`}{" "}
        Taking you to your dashboard…
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-linen flex flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Logo dark={false} />
      </div>
      <div className="card w-full max-w-[440px] p-6 sm:p-8">{children}</div>
      <p className="mt-6 text-[14px] text-ink/75">
        <Link href="/" className="underline font-semibold">
          ← Back to ShelfSense
        </Link>
      </p>
    </main>
  );
}

function DemoMode({ next }: { next: string }) {
  const { data: health } = useApi<Health>("/health");
  const mismatch = authMismatch(health?.auth_mode);
  return (
    <Shell>
      <span className="sticker">Demo mode</span>
      <h1 className="text-[32px] leading-[38px] mt-5">No login needed</h1>
      <p className="text-[16px] leading-[25px] mt-3 text-ink/85">
        This ShelfSense install runs without accounts: everyone uses one shared demo seller, and checks run
        through the simulated TinyFish agent unless API keys are configured.
      </p>
      <p className="text-[14px] leading-[22px] mt-3 text-ink/75">
        To turn on real sign-in, set <code className="font-mono text-[13px]">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-[13px]">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in the frontend and{" "}
        <code className="font-mono text-[13px]">SUPABASE_JWT_SECRET</code> (or{" "}
        <code className="font-mono text-[13px]">SUPABASE_JWKS_URL</code>) on the backend.
      </p>
      {mismatch && (
        <p role="alert" className="mt-4 bg-sand border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
          ✕ {mismatch}
        </p>
      )}
      <Link href={next} className="btn btn-primary w-full mt-6">
        Continue to dashboard
      </Link>
    </Shell>
  );
}

function SupabaseLogin({ next }: { next: string }) {
  const router = useRouter();
  const { ready, session } = useAuth();
  const [method, setMethod] = useState<Method>("password");
  const [intent, setIntent] = useState<Intent>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Session check against the backend: "checking", "ok" (welcome animation, then leave), or a
  // failure that keeps the session (network).
  const [verify, setVerify] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const verified = useRef<string | null>(null);
  // Waiting for the emailed code.
  const [otp, setOtp] = useState<{ email: string; kind: OtpKind } | null>(null);
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  // A freshly verified signup gets "You're all set!" instead of "Welcome back!".
  const [firstTime, setFirstTime] = useState(false);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  // Load the destination while the user types, so the post-login hop is instant.
  useEffect(() => {
    router.prefetch(next);
  }, [router, next]);

  // Why the previous session was dropped (the backend rejected its token).
  useEffect(() => {
    const msg = takeAuthError();
    if (msg) setError(`${msg}. Check that the backend's SUPABASE_JWT_SECRET / SUPABASE_URL belong to the same Supabase project as the frontend.`);
  }, []);

  /**
   * Only leave /login once the backend accepts the token. Otherwise the app's first 401 would send
   * the user back here, which would forward them again: an endless /login <-> /dashboard loop.
   */
  const checkSession = useCallback(async () => {
    setVerify("checking");
    try {
      await api("/me", { noAuthRedirect: true });
      setVerify("ok");
      // Let the tick finish drawing before the dashboard takes over.
      window.setTimeout(() => router.replace(next), prefersReducedMotion() ? 300 : 1100);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 409)) {
        await signOutLocal();
        setVerify("idle");
        setError(
          `You signed in, but the ShelfSense server refused the session: ${e.message}.` +
            (e.status === 401 ? " The backend's SUPABASE_JWT_SECRET / SUPABASE_URL probably don't match this Supabase project." : ""),
        );
        return;
      }
      setVerify("failed");
      setError(errorMessage(e, "Couldn't reach the ShelfSense server"));
    }
  }, [next, router]);

  useEffect(() => {
    if (!ready || !session) return;
    if (verified.current === session.access_token) return;
    verified.current = session.access_token;
    void checkSession();
  }, [ready, session, checkSession]);

  /** Switches to the "enter the code" step for `addr`. */
  const awaitCode = (addr: string, kind: OtpKind) => {
    setOtp({ email: addr, kind });
    setCode("");
    setError(null);
    setNotice(null);
    setResendIn(RESEND_SECONDS);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const client = getSupabase();
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const addr = email.trim();
    try {
      const sb = await client;
      if (method === "code") {
        const { error: err } = await sb.auth.signInWithOtp({ email: addr });
        if (err) throw err;
        awaitCode(addr, "email");
      } else if (intent === "signup") {
        const { data, error: err } = await sb.auth.signUp({ email: addr, password });
        if (err) throw err;
        // Supabase answers an already-registered email with a user that has no identities (and
        // sends nothing), so the code would never arrive.
        if (data.user && data.user.identities?.length === 0) {
          setError("An account with this email already exists. Sign in instead.");
          setIntent("signin");
          return;
        }
        setFirstTime(true);
        // With "Confirm email" off there's a session straight away and the effect above takes over.
        if (!data.session) awaitCode(addr, "signup");
      } else {
        const { error: err } = await sb.auth.signInWithPassword({ email: addr, password });
        if (err) {
          // Signed up earlier but never typed the code: send a fresh one and ask for it here.
          if ((err as { code?: string }).code === "email_not_confirmed" || /not confirmed/i.test(err.message)) {
            await sb.auth.resend({ type: "signup", email: addr });
            setFirstTime(true);
            awaitCode(addr, "signup");
            setNotice("Your email isn't verified yet, so we sent you a new code.");
            return;
          }
          throw err;
        }
      }
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (token: string) => {
    const client = getSupabase();
    if (!client || !otp || busy || token.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const sb = await client;
      const { error: err } = await sb.auth.verifyOtp({ email: otp.email, token, type: otp.kind });
      if (err) throw err;
      // The new session reaches useAuth, and the effect above checks it with the backend.
    } catch (err) {
      setError(authError(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    const client = getSupabase();
    if (!client || !otp || resendIn > 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sb = await client;
      const { error: err } =
        otp.kind === "signup" ? await sb.auth.resend({ type: "signup", email: otp.email }) : await sb.auth.signInWithOtp({ email: otp.email });
      if (err) throw err;
      setCode("");
      setResendIn(RESEND_SECONDS);
      setNotice(`New code sent to ${otp.email}.`);
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  };

  if (ready && session) {
    if (verify === "failed") {
      return (
        <Shell>
          <h1 className="text-[28px] leading-[34px]">Signed in, but the server is unreachable</h1>
          <p role="alert" className="mt-4 bg-sand border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
            ✕ {error}
          </p>
          <div className="flex flex-wrap gap-3 mt-6">
            <button type="button" className="btn btn-primary" onClick={() => void checkSession()}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setError(null);
                setVerify("idle");
                void signOutLocal();
              }}
            >
              Sign out
            </button>
          </div>
        </Shell>
      );
    }
    if (verify === "ok") {
      return (
        <Shell>
          <Welcome firstTime={firstTime} email={session.user?.email ?? null} />
        </Shell>
      );
    }
    return (
      <Shell>
        <p className="flex items-center gap-3 font-semibold" role="status">
          <span className="ss-spin" aria-hidden /> Signed in — checking your session…
        </p>
      </Shell>
    );
  }

  if (otp) {
    return (
      <Shell>
        <div className="auth-step">
          <h1 className="text-[32px] leading-[38px]">Enter your code</h1>
          <p className="text-[15px] mt-2 text-ink/80">
            We sent a {OTP_LENGTH}-digit code to <span className="font-semibold text-ink">{otp.email}</span>.
            {otp.kind === "signup" ? " Enter it to verify your account." : " Enter it to sign in."} Check Spam if it isn&apos;t there.
          </p>
          <form
            className="flex flex-col gap-4 mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode(code);
            }}
          >
            <OtpInput value={code} onChange={setCode} onComplete={(c) => void verifyCode(c)} length={OTP_LENGTH} disabled={busy} invalid={!!error} />
            {error && (
              <p role="alert" className="bg-sand border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
                ✕ {error}
              </p>
            )}
            {notice && (
              <p role="status" className="bg-sage/30 border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
                ✓ {notice}
              </p>
            )}
            <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== OTP_LENGTH}>
              {busy && <span className="ss-spin border-linen/40 border-t-linen" aria-hidden />}
              {otp.kind === "signup" ? "Verify & continue" : "Sign in"}
            </button>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-3 mt-5 text-[14px]">
            <button
              type="button"
              className="font-semibold underline disabled:no-underline disabled:text-ink/60"
              onClick={() => void resend()}
              disabled={resendIn > 0 || busy}
            >
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
            </button>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                setOtp(null);
                setCode("");
                setError(null);
                setNotice(null);
              }}
            >
              Use a different email
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  const title = method === "code" ? "Sign in with a code" : intent === "signup" ? "Create your account" : "Sign in";
  return (
    <Shell>
      <h1 className="text-[32px] leading-[38px]">{title}</h1>
      <p className="text-[15px] mt-2 text-ink/80">See your market the way shoppers do — pincode by pincode.</p>

      <div className="flex gap-2 mt-6" role="group" aria-label="Sign-in method">
        <button type="button" className="pill flex-1" data-active={method === "password"} aria-pressed={method === "password"} onClick={() => setMethod("password")}>
          Password
        </button>
        <button type="button" className="pill flex-1" data-active={method === "code"} aria-pressed={method === "code"} onClick={() => setMethod("code")}>
          Email code
        </button>
      </div>

      <form className="flex flex-col gap-4 mt-6" onSubmit={submit}>
        <label className="flex flex-col gap-1.5">
          <span className="label">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourbrand.in"
          />
        </label>
        {method === "password" && (
          <label className="flex flex-col gap-1.5">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete={intent === "signup" ? "new-password" : "current-password"}
              required
              minLength={intent === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="bg-sand border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
            ✕ {error}
          </p>
        )}
        {notice && (
          <p role="status" className="bg-sage/30 border-2 border-ink rounded-[12px] px-4 py-3 text-[14px] font-semibold">
            ✓ {notice}
          </p>
        )}
        <button type="submit" className="btn btn-primary w-full" disabled={busy || !email.trim() || (method === "password" && !password)}>
          {busy && <span className="ss-spin border-linen/40 border-t-linen" aria-hidden />}
          {method === "code" ? "Email me a code" : intent === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>

      {method === "password" && (
        <p className="text-[14px] mt-5 text-center">
          {intent === "signin" ? "New to ShelfSense? " : "Already have an account? "}
          <button type="button" className="font-semibold underline" onClick={() => setIntent(intent === "signin" ? "signup" : "signin")}>
            {intent === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      )}
    </Shell>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  return AUTH_ENABLED ? <SupabaseLogin next={next} /> : <DemoMode next={next} />;
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
