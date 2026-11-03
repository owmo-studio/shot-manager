import type { VideoMetadata } from './shots'

export type ViewingProfile = 'sony-slog3-cine' | 'apple-log'
export interface ViewingLut {
  profile: ViewingProfile
  size: number
  values: number[]
  fingerprint: string
}

// Select from original capture declarations, never from filenames or folders.
export function viewingProfile(metadata: VideoMetadata): ViewingProfile | null {
  const { transfer, primaries } = metadata.color
  if (transfer?.startsWith('s-log3') && primaries === 's-gamut3-cine') return 'sony-slog3-cine'
  if (transfer === 'apple-log' && primaries === 'bt2020') return 'apple-log'
  return null
}
