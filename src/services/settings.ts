import { prisma } from '../db';
import { DEFAULT_SETTINGS } from './defaultSettings';

const cache = new Map<string, { value: unknown; at: number }>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value as T;
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = (row ? row.value : DEFAULT_SETTINGS[key] ?? fallback) as T;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function clearSettingsCache() {
  cache.clear();
}
