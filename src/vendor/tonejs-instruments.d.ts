import type * as Tone from 'tone'

export const SampleLibrary: {
  setExt(extension: string): void
  load(options: {
    instruments: string
    baseUrl?: string
    ext?: string
    minify?: boolean
    onload?: () => void
  }): Tone.Sampler
}
