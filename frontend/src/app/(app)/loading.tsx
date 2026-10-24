/** Route-level loading state for the app shell: header + card skeletons in the Holst style. */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-8" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-3">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-11 w-full max-w-96" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card p-6 flex flex-col gap-3">
            <div className="skeleton h-5 w-1/2" />
            <div className="skeleton h-14 w-2/3" />
            <div className="skeleton h-4 w-full" />
          </div>
        ))}
      </div>
      <div className="card p-6 flex flex-col gap-3">
        <div className="skeleton h-5 w-1/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-5/6" />
        <div className="skeleton h-4 w-2/3" />
      </div>
    </div>
  );
}
