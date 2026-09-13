export const TERRAIN_THEMES = {
  'green-valley': { label: 'Green Valley', range: 'GREEN VALLEY RANGE', landscape: 'an endless mountain valley' },
  desert: { label: 'Desert', range: 'DESERT RANGE', landscape: 'a sunlit desert of sand and ripples' },
} as const;

export type TerrainTheme = keyof typeof TERRAIN_THEMES;

export function isTerrainTheme(value: unknown): value is TerrainTheme {
  return value === 'green-valley' || value === 'desert';
}
