import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackendStatus } from '../../shared/desktop'
import './styles.css'

function App() {
  const [status, setStatus] = useState<BackendStatus>({ state: 'starting', message: 'Starting backend…' })

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const nextStatus = await window.desktop.getBackendStatus()
        if (!disposed) setStatus(nextStatus)
      } catch {
        if (!disposed) setStatus({ state: 'unavailable', message: 'Desktop connection unavailable.' })
      }
      if (!disposed) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])

  return (
    <div className="flex h-screen flex-col bg-[#111318] text-sm text-zinc-200">
      <header className="flex items-center justify-between border-b border-white/8 px-6 py-4">
        <h1 className="font-semibold tracking-tight">OWMO <span className="font-normal text-zinc-400">Shot Manager</span></h1>
        <nav aria-label="Workspace" className="flex gap-1 rounded-lg bg-white/4 p-1">
          <span aria-current="page" className="rounded-md bg-white/10 px-5 py-1.5">Import</span>
          <button disabled title="Library is planned for a later milestone" className="px-5 py-1.5 text-zinc-600">Library</button>
        </nav>
        <span className="text-xs text-zinc-500">Development</span>
      </header>
      <main className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r border-white/8 bg-white/[0.015] p-5">
          <h2 className="font-medium text-zinc-300">Sources</h2>
          <p className="mt-4 text-xs leading-6 text-zinc-500">No sources connected.</p>
        </aside>
        <section className="flex flex-1 items-center justify-center p-10 text-center">
          <div className="max-w-md">
            <div className="mx-auto mb-6 grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/4 text-2xl text-zinc-500" aria-hidden="true">＋</div>
            <h2 className="text-xl font-medium tracking-tight">Your workspace is ready</h2>
            <p className="mt-3 leading-6 text-zinc-500">A clean start for your footage. Source browsing and ingestion will be added here.</p>
            <p className="mt-6 text-xs text-zinc-600">No media folders are accessed by this starter.</p>
          </div>
        </section>
      </main>
      <footer className="flex items-center justify-between border-t border-white/8 px-5 py-3 text-xs text-zinc-500">
        <div role="status" className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${status.state === 'connected' ? 'bg-emerald-400' : status.state === 'starting' ? 'bg-amber-400' : 'bg-red-400'}`} />
          {status.state === 'connected' ? 'Backend connected' : status.message}
        </div>
        <span>Dummy data only · No active operations</span>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
