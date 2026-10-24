"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

/** Route-level error boundary (root segment). Keeps the Holst look and offers a retry. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);
  // reset() alone re-renders the same cached result; refresh re-fetches the route first.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <main className="min-h-[70vh] grid place-items-center px-4 py-16">
      <div className="card bg-sand max-w-[520px] w-full p-8" role="alert">
        <p className="eyebrow text-slate">Something broke</p>
        <h1 className="text-[34px] leading-[40px] mt-2">This page hit an error</h1>
        <p className="text-[16px] leading-[25px] mt-3">
          Your data is safe — this is a display problem. Try again, and if it keeps happening, reload the page.
        </p>
        {error.digest && <p className="text-[13px] mt-3 text-ink/75 font-mono">Ref: {error.digest}</p>}
        <div className="flex flex-wrap gap-3 mt-6">
          <button type="button" className="btn btn-ink" onClick={retry}>
            Try again
          </button>
          <Link href="/dashboard" className="btn btn-ghost">
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
