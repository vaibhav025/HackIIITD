import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-linen grid place-items-center px-4 py-16">
      <div className="card max-w-[520px] w-full p-8 text-center">
        <span className="sticker">404 · Not on the shelf</span>
        <h1 className="text-[40px] leading-[46px] mt-6">We couldn&apos;t find that page</h1>
        <p className="text-[16px] leading-[25px] mt-3 text-ink/80">
          The link may be old, or the product was removed. Everything you track is one click away.
        </p>
        <div className="flex flex-wrap gap-3 justify-center mt-7">
          <Link href="/dashboard" className="btn btn-primary">
            Go to dashboard
          </Link>
          <Link href="/products" className="btn btn-ghost">
            Your products
          </Link>
        </div>
      </div>
    </main>
  );
}
