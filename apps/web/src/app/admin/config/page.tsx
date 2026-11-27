'use client';

/**
 * Game settings — /admin/config.
 *
 * Defaults as steppers only (no sliders), one-line explainer under
 * every control. Save needs a confirm; invalid values are refused
 * with plain-words errors. Staff sees the values but cannot save.
 */
import { useEffect, useState } from 'react';
import { ADMIN_CONFIG_DEFAULTS, ADMIN_CONFIG_LIMITS, ADMIN_CONFIG_PLACEBO_LABEL, adminCan, adminConfigError, type AdminGameConfig } from '@pakdam/shared';
import { AdminApiError, getAdminConfig, saveAdminConfig } from '../../../lib/admin/admin-client';
import { readAdminSession } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import { Stepper } from '../../../components/ui/Stepper';
import { Toggle } from '../../../components/ui/Toggle';
import {
  AdminCard,
  AdminDenied,
  AdminError,
  AdminLoading,
  ConfirmAction,
  Explainer,
} from '../../../components/admin/AdminUi';
import { ADMIN_DENIED_MESSAGE } from '@pakdam/shared';

const FIELDS: {
  key: keyof AdminGameConfig;
  label: string;
  explainer: string;
  format: (v: number) => string;
  min: number;
  max: number;
}[] = [
  {
    key: 'roundLengthMinutes',
    label: 'Round length',
    explainer: 'How long one game lasts, in minutes.',
    format: (v) => `${v} min`,
    min: 5,
    max: 180,
  },
  {
    key: 'headStartMinutes',
    label: 'Head start',
    explainer: 'How long Runners get to hide before Hunters start.',
    format: (v) => `${v} min`,
    min: 0,
    max: 30,
  },
  {
    key: 'pingIntervalMinutes',
    label: 'Ping interval',
    explainer: 'How often opponents are pinged. 0 means no pings.',
    format: (v) => (v === 0 ? 'Off' : `${v} min`),
    min: 0,
    max: 30,
  },
  {
    key: 'zoneRadiusMetres',
    label: 'Zone size',
    explainer: 'The starting play-zone radius, in metres.',
    format: (v) => `${v} m`,
    min: 100,
    max: 5000,
  },
  {
    key: 'shrinkEverySeconds',
    label: 'Shrinks every',
    explainer: 'Seconds between zone shrinks, when shrinking is on.',
    format: (v) => `${Math.round(v / 60)} min`,
    min: 60,
    max: 1800,
  },
];

export default function AdminConfigPage() {
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canEdit = adminCan(role, 'config.edit');
  const { data, loading, error, retry } = useAdminData(() => getAdminConfig());
  const [draft, setDraft] = useState<AdminGameConfig>(ADMIN_CONFIG_DEFAULTS);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const setValue = (key: keyof AdminGameConfig, value: number) => {
    const err =
      key === 'zoneShrinkEnabled' ? null : adminConfigError(key as keyof typeof ADMIN_CONFIG_LIMITS, value);
    setFieldError(err);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    for (const field of FIELDS) {
      const err = adminConfigError(field.key as never, draft[field.key] as number);
      if (err) {
        setFieldError(`${field.label}: ${err}`);
        return;
      }
    }
    setSaveError(null);
    setSaved(false);
    try {
      await saveAdminConfig(draft);
      setSaved(true);
      retry();
    } catch (err) {
      setSaveError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Game settings</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Default settings for new games. Changes apply at once — no deploy.</p>
        <p role="status" className="mt-3 rounded-[14px] border border-[#F59E0B]/50 bg-[#141416] px-4 py-3 text-[14px] font-semibold text-[#F59E0B]">
          {ADMIN_CONFIG_PLACEBO_LABEL}
        </p>
      </div>

      {loading ? <AdminLoading what="game settings" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {fieldError ? (
        <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {fieldError}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          Saved. New games use these settings.
        </p>
      ) : null}
      {!canEdit ? <AdminDenied message={ADMIN_DENIED_MESSAGE} /> : null}

      {data ? (
        <AdminCard>
          {FIELDS.map((field) => (
            <div key={field.key} className="border-b border-[#26262B] py-3 last:border-b-0">
              <p className="mb-2 text-[15px] font-bold text-white">{field.label}</p>
              <Stepper
                value={draft[field.key] as number}
                label={field.label}
                min={field.min}
                max={field.max}
                format={field.format}
                disabled={!canEdit}
                onChange={(value) => setValue(field.key, value)}
              />
              <Explainer>{field.explainer}</Explainer>
            </div>
          ))}
          <div className="border-b border-[#26262B] py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px] font-bold text-white">Zone shrinking</p>
              {/* Merge, 2026-11-27 (Meera fix 5): the shared Toggle the
                  flags page already uses — the hand-rolled switch
                  duplicated it exactly (48×24 capsule, same knob). */}
              <Toggle
                checked={draft.zoneShrinkEnabled}
                label="Zone shrinking"
                disabled={!canEdit}
                onChange={(checked) => setDraft((d) => ({ ...d, zoneShrinkEnabled: checked }))}
              />
            </div>
            <Explainer>When on, the play zone shrinks as the game goes on.</Explainer>
          </div>

          {canEdit ? (
            <div className="mt-4">
              <ConfirmAction
                label="Save settings"
                confirmLabel="Tap again to save"
                consequence="New games will use these settings. Games already running are not affected."
                onConfirm={save}
                danger={false}
              />
            </div>
          ) : null}
        </AdminCard>
      ) : null}
    </>
  );
}
