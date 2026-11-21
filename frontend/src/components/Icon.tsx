import type { CSSProperties } from 'react'

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17',
  sliders: 'M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m8 4v6',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  bowl: 'M3 11h18a9 9 0 0 1-18 0Zm3 9h12M8 3v4m4-5v5m4-4v4',
  leaf: 'M20 3c-9-1-16 3-16 9a7 7 0 0 0 7 7c6 0 9-7 9-16ZM3 21 15 9',
  flame: 'M12 3c1 5 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 4-7 0 4 2 4 2 4s2-4 0-8Z',
  lemon: 'M5 6c3-4 9-4 12-1l2 1 1 3c2 5-1 10-6 11l-4-1-3-1c-4-3-5-8-2-12Zm2 3c-1 3 0 5 2 6',
  chef: 'M7 14a5 5 0 1 1 1-9 5 5 0 0 1 8 0 5 5 0 1 1 1 9v6H7v-6Zm0 3h10',
  fish: 'M3 12s4-6 9-6c4 0 7 6 7 6s-3 6-7 6c-5 0-9-6-9-6Zm16 0 3-5v10l-3-5M8 11h.01',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  book: 'M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Zm0 0v15',
  fridge: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM4 9h16M8 5v1m0 7v3',
  dining: 'M4 3v6a3 3 0 0 0 6 0V3M7 3v18M18 3c-3 3-3 7 0 9h2V3h-2Zm2 9v9',
  portion: 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM3 21c0-5 4-8 9-8s9 3 9 8',
} as const

export type IconName = keyof typeof paths

export default function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <path d={paths[name]} />
    </svg>
  )
}
