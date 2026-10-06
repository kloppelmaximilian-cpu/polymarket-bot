import { systemSettings, type DbOrTx } from '@aoc/database';
import { eq } from 'drizzle-orm';

export const SETTING_KEYS = {
  emergencyStop: 'emergency_stop',
  scoringWeights: 'scoring_weights',
  gateThresholds: 'gate_thresholds',
} as const;

export interface EmergencyStopState {
  engaged: boolean;
  reason: string | null;
  engagedAt: string | null;
  engagedBy: string | null;
  releasedAt: string | null;
}

export async function getSetting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return row ? (row.value as T) : fallback;
}

export async function putSetting(db: DbOrTx, key: string, value: unknown, by: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key, value, updatedBy: by })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy: by, updatedAt: new Date() } });
}

export async function getEmergencyStop(db: DbOrTx): Promise<EmergencyStopState> {
  return getSetting<EmergencyStopState>(db, SETTING_KEYS.emergencyStop, { engaged: false, reason: null, engagedAt: null, engagedBy: null, releasedAt: null });
}
