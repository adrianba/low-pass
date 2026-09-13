import type { Quality } from '../config/game';
import { isTerrainTheme } from '../config/terrain';
import type { TerrainTheme } from '../config/terrain';

export interface Settings { quality: Quality; assist: boolean; muted: boolean; volume: number; terrain: TerrainTheme }
export interface Score { id: string; score: number; date: string; assisted: boolean }
interface Records { version: 1; scores: Score[]; settings: Settings }
export const DEFAULT_SETTINGS: Settings = { quality: 'medium', assist: true, muted: false, volume: 0.55, terrain: 'green-valley' };
export const STORAGE_KEY = 'low-pass.records.v1';
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validScore(value: unknown): value is Score {
  return object(value) && typeof value.id === 'string' && value.id.length <= 100
    && Number.isSafeInteger(value.score) && Number(value.score) >= 0
    && typeof value.date === 'string' && Number.isFinite(Date.parse(value.date))
    && typeof value.assisted === 'boolean';
}
export function validSettings(value: unknown): value is Settings {
  return object(value) && ['low', 'medium', 'high'].includes(String(value.quality))
    && typeof value.assist === 'boolean' && typeof value.muted === 'boolean'
    && typeof value.volume === 'number' && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1
    && isTerrainTheme(value.terrain);
}
function validRecords(value: unknown): value is Records {
  return object(value) && value.version === 1 && Array.isArray(value.scores)
    && value.scores.length <= 10 && value.scores.every(validScore) && validSettings(value.settings);
}

export class RecordStore {
  private records: Records = { version: 1, scores: [], settings: { ...DEFAULT_SETTINGS } };
  private storage: StoragePort | null = null;

  constructor(getStorage: () => StoragePort, private readonly warn: (message: string) => void) {
    try {
      this.storage = getStorage();
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw !== null) {
        let value: unknown = JSON.parse(raw);
        let recoveredTerrain = false;
        if (object(value) && value.version === 1 && object(value.settings) && !isTerrainTheme(value.settings.terrain)) {
          recoveredTerrain = Object.hasOwn(value.settings, 'terrain');
          value = { ...value, settings: { ...value.settings, terrain: 'green-valley' } };
        }
        if (!validRecords(value)) throw new Error('Saved data has an invalid format.');
        this.records = value;
        if (recoveredTerrain) this.warn('Saved terrain choice was invalid. Using Green Valley; your scores and other settings are retained.');
      }
    } catch (error) {
      this.storage = null;
      this.warn(`Local scores/settings unavailable: ${error instanceof Error ? error.message : String(error)} Changes will last only this session.`);
    }
  }
  get settings(): Settings { return { ...this.records.settings }; }
  get scores(): readonly Score[] { return this.records.scores; }

  update(settings: Settings): void {
    if (!validSettings(settings)) throw new Error('Invalid settings.');
    this.records.settings = { ...settings };
    this.save();
  }
  complete(score: Score): void {
    if (!validScore(score)) throw new Error('Invalid completed score.');
    if (this.records.scores.some(item => item.id === score.id)) return;
    this.records.scores = [...this.records.scores, score]
      .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, 10);
    this.save();
  }
  private save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.records)); }
    catch (error) {
      this.storage = null;
      this.warn(`Could not save local records: ${error instanceof Error ? error.message : String(error)} Changes will last only this session.`);
    }
  }
}
