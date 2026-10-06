import { ActionForm, Field, Submit } from '@/components/forms';
import { Badge, Card, KeyValues, Notice, PageHeader } from '@/components/ui';
import { updateGateThresholds, updateScoringWeights } from '@/lib/actions';
import { apiGet } from '@/lib/api';
import type { Settings } from '@/lib/types';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const s = await apiGet<Settings>('/v1/settings');
  const weights = s.scoringWeights;
  const gates = s.gateThresholds;
  const wOverrides = weights.overrides as Record<string, number>;
  const gOverrides = gates.overrides as Record<string, number>;
  return (
    <div className="space-y-4">
      <PageHeader title="Settings" subtitle="Configuration comes from environment variables (.env); secrets are never shown. Scoring weights and gate thresholds can be tuned here — every change is audited." />
      <Notice tone="blue" title="Trading mode">
        {s.mode.statement}
      </Notice>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Opportunity score weights" subtitle="Relative weights of the sub-scores (normalised). Risk additionally multiplies the score, and evidence caps it.">
          <ActionForm action={updateScoringWeights} className="grid grid-cols-2 gap-3">
            {Object.entries(weights.defaults).map(([k, def]) => (
              <Field key={k} label={(weights.labels as Record<string, string>)[k] ?? k} hint={`default ${def}${wOverrides[k] !== undefined ? ' · overridden' : ''}`}>
                <input name={k} type="number" min={0} max={1} step={0.01} defaultValue={wOverrides[k] ?? def} />
              </Field>
            ))}
            <div className="col-span-full">
              <Submit>Save weights</Submit>
            </div>
          </ActionForm>
        </Card>
        <Card title="Quality-gate thresholds" subtitle="Minimum evidence before paper testing, PROMISING and live review. Lowering them makes lucky streaks more likely to pass.">
          <ActionForm action={updateGateThresholds} className="grid grid-cols-2 gap-3">
            {Object.entries(gates.defaults).map(([k, def]) => (
              <Field key={k} label={k} hint={`default ${String(def)}${gOverrides[k] !== undefined ? ' · overridden' : ''}`}>
                <input name={k} type="number" min={0} step="any" defaultValue={gOverrides[k] ?? (def as number)} />
              </Field>
            ))}
            <div className="col-span-full">
              <Submit>Save thresholds</Submit>
            </div>
          </ActionForm>
        </Card>
      </div>
      <Card title="Configuration" subtitle="Read-only. Change it in .env and restart.">
        <KeyValues
          rows={Object.entries(s.config).map(([k, v]) => [
            <span key={k} className="font-mono text-xs">
              {k}
            </span>,
            v === '[REDACTED]' || (typeof v === 'string' && v.includes('***')) ? (
              <Badge key={`${k}v`} tone="gray">
                {String(v)}
              </Badge>
            ) : (
              <span key={`${k}v`} className="font-mono text-xs">
                {v === undefined ? '—' : String(v)}
              </span>
            ),
          ])}
        />
      </Card>
    </div>
  );
}
