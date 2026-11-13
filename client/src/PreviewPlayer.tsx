import { useClipView } from "./ClipViewContext";
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { VideoShot } from '../../shared/shots'
import { viewingProfile } from '../../shared/viewing'
import type { ViewingLut } from '../../shared/viewing'
import { cardDuration } from './mediaInfo'
import { ViewingRenderer } from './viewingRenderer'

export interface PreviewHandle { captureThumbnail: () => string }

export function PreviewPlayer({ shot, lutEnabled, ref, onReady, onScrubbing }: {
  shot: VideoShot; lutEnabled: boolean; ref: Ref<PreviewHandle>; onReady: (ready: boolean) => void; onScrubbing: (scrubbing: boolean) => void
}) {
  const { api, mediaURL } = useClipView();
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const renderer = useRef<ViewingRenderer | null>(null)
  const enabled = useRef(lutEnabled)
  enabled.current = lutEnabled
  const readyCallback = useRef(onReady)
  readyCallback.current = onReady
  const scrubbing = useRef(false)
  const scrubbingCallback = useRef(onScrubbing)
  scrubbingCallback.current = onScrubbing
  function finishScrubbing() {
    scrubbing.current = false
    scrubbingCallback.current(false)
  }
  useEffect(() => {
    window.addEventListener('blur', finishScrubbing)
    // Native range controls may retarget the release outside the input.
    window.addEventListener('pointerup', finishScrubbing, true)
    window.addEventListener('pointercancel', finishScrubbing, true)
    return () => {
      window.removeEventListener('blur', finishScrubbing)
      window.removeEventListener('pointerup', finishScrubbing, true)
      window.removeEventListener('pointercancel', finishScrubbing, true)
      scrubbingCallback.current(false)
    }
  }, [])
  const [lut, setLut] = useState<ViewingLut | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [lutError, setLutError] = useState<string | null>(null)
  const [gpuError, setGpuError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const profile = viewingProfile(shot.metadata)

  useEffect(() => {
    let disposed = false
    setLut(undefined)
    setLutError(null)
    if (!profile) { setLut(null); return }
    api.getShotLut(shot.id).then((table) => {
      if (disposed) return
      if (!table || table.profile !== profile) throw new Error('Missing LUT')
      setLut(table)
    }).catch(() => {
      if (!disposed) { setLut(null); setLutError('Viewing LUT is unavailable. Showing the original video.') }
    })
    return () => { disposed = true }
  }, [shot.id, profile])

  useEffect(() => {
    const player = video.current, output = canvas.current
    if (!player || !output || lut === undefined) return
    let disposed = false, callback = 0
    setGpuError(false)
    try { renderer.current = new ViewingRenderer(output, lut, shot.metadata) }
    catch { setGpuError(true); return }
    const draw = () => {
      try { if (renderer.current?.draw(player, enabled.current)) readyCallback.current(!profile || !!lut) }
      catch { disposed = true; setGpuError(true); readyCallback.current(false) }
    }
    const tick = () => { if (disposed) return; draw(); if (!disposed) callback = player.requestVideoFrameCallback(tick) }
    const loading = () => readyCallback.current(false)
    const contextLost = (event: Event) => {
      event.preventDefault()
      disposed = true
      player.cancelVideoFrameCallback(callback)
      readyCallback.current(false)
      setGpuError(true)
    }
    const refresh = () => { draw(); setPosition(player.currentTime) }
    player.addEventListener('loadeddata', refresh)
    player.addEventListener('seeked', refresh)
    player.addEventListener('seeking', loading)
    output.addEventListener('webglcontextlost', contextLost)
    callback = player.requestVideoFrameCallback(tick)
    draw()
    return () => {
      disposed = true
      player.cancelVideoFrameCallback(callback)
      player.removeEventListener('loadeddata', refresh)
      player.removeEventListener('seeked', refresh)
      player.removeEventListener('seeking', loading)
      output.removeEventListener('webglcontextlost', contextLost)
      renderer.current?.dispose()
      renderer.current = null
      readyCallback.current(false)
    }
  }, [shot.id, lut, profile, shot.metadata.color.matrix])

  useEffect(() => {
    if (video.current && renderer.current) {
      try { renderer.current.draw(video.current, lutEnabled) } catch { setGpuError(true) }
    }
  }, [lutEnabled])

  useImperativeHandle(ref, () => ({ captureThumbnail() {
    const player = video.current, output = canvas.current, gpu = renderer.current
    if (!player || !output || !gpu || gpuError || scrubbing.current || player.seeking || (profile && !lut) || !gpu.draw(player, true)) throw new Error('Wait for a transformed frame.')
    const image = document.createElement('canvas')
    const scale = Math.min(1, 480 / output.width, 270 / output.height)
    image.width = Math.max(1, Math.round(output.width * scale))
    image.height = Math.max(1, Math.round(output.height * scale))
    try {
      const context = image.getContext('2d')
      if (!context) throw new Error('Frame capture is unavailable.')
      context.drawImage(output, 0, 0, image.width, image.height)
      return image.toDataURL('image/jpeg', .9)
    } finally { gpu.draw(player, enabled.current) }
  } }), [gpuError, lut, profile])

  const unsupportedColor = !profile && shot.metadata.color.transfer !== 'bt709'
  return <div ref={container} className="preview-player bg-black">
    <div className="preview-image relative aspect-video overflow-hidden">
      <video ref={video} crossOrigin="anonymous" src={mediaURL(shot.id)}
        className={'absolute inset-0 size-full object-contain ' + (gpuError ? '' : 'opacity-0')}
        controls={gpuError} controlsList="nodownload noplaybackrate noremoteplayback"
        disablePictureInPicture disableRemotePlayback playsInline preload="auto" aria-label={'Preview ' + shot.filename}
        onLoadStart={() => { readyCallback.current(false); setError(null); setPosition(0); setDuration(0); setPlaying(false) }}
        onLoadedMetadata={() => setDuration(Number.isFinite(video.current?.duration) ? video.current!.duration : 0)}
        onTimeUpdate={() => setPosition(video.current?.currentTime ?? 0)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onError={() => { readyCallback.current(false); setError('Preview unavailable. Check the file or codec.') }} />
      {!gpuError && <canvas ref={canvas} className="absolute inset-0 size-full object-contain" aria-label="Video viewing image" />}
    </div>
    {!gpuError && <div className="flex items-center gap-3 px-3 py-2 text-xs text-zinc-400">
      <button type="button" aria-label={playing ? 'Pause preview' : 'Play preview'} className="size-6 hover:text-white"
        onClick={() => { const p = video.current; if (p) { if (p.paused) void p.play().catch(() => setError('Playback could not start.')); else p.pause() } }}>{playing ? 'Ⅱ' : '▶'}</button>
      <span className="whitespace-nowrap text-[11px] tabular-nums">{cardDuration(position)} / {cardDuration(duration)}</span>
      <input type="range" aria-label="Seek preview" min={0} max={duration || 1} step={.01} value={Math.min(position, duration || 1)}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          scrubbing.current = true
          scrubbingCallback.current(true)
        }}
        onPointerUp={finishScrubbing} onPointerCancel={finishScrubbing} onLostPointerCapture={finishScrubbing}
        disabled={!duration} onChange={(event) => { if (video.current) video.current.currentTime = Number(event.target.value) }} className="min-w-0 flex-1 accent-zinc-400" />
      <button type="button" aria-label={muted ? 'Unmute preview' : 'Mute preview'} className="size-6 hover:text-white"
        onClick={() => { if (video.current) { video.current.muted = !muted; setMuted(!muted) } }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5z" />{muted ? <path d="m16 9 6 6m0-6-6 6"/> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>}</svg>
      </button>
      <button type="button" aria-label="Fullscreen preview" className="size-6 hover:text-white" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : container.current?.requestFullscreen())?.catch(() => setError('Fullscreen is unavailable.'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>
      </button>
    </div>}
    {(error || gpuError || lutError || (lutEnabled && unsupportedColor)) && <p role="status" className="px-3 pb-3 text-xs leading-5 text-amber-300">
      {error ?? (gpuError ? 'Viewing LUT unavailable. Showing original video.' : lutError ?? 'No matching LUT. Showing original video.')}
    </p>}
  </div>
}
