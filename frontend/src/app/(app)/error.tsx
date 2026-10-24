"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

/**
 * Error boundary for app pages. It sits inside the (app) layout, so the sidebar and top bar
 * stay usable and only the page area shows the error.
 */
export default function AppPageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
    <div className="card bg-sand max-w-[560px] w-full p-8" role="alert">
      <p className="eyebrow text-slate">Something broke</p>
      <h1 className="text-[34px] leading-[40px] mt-2">This page hit an error</h1>
      <p className="text-[16px] leading-[25px] mt-3">
        Your data is safe — this is a display problem. Try again, or use the menu to open another page.
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
  );
}
