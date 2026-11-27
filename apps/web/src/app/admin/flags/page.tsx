'use client';

/**
 * Feature switches — /admin/flags.
 *
 * Every flag is a capsule toggle (the shared Toggle component) with
 * a one-line explainer underneath. Changes apply without a deploy —
 * the server reads flags at runtime. Each flag shows who last
 * changed it and when. Staff sees the list but cannot change
 * anything.
 */
import { useState } from 'react';
import {
  ADMIN_DENIED_MESSAGE,
  ADMIN_FLAG_DEFS,
  ADMIN_FUTURE_FLAGS,
  ADMIN_PLACEBO_LABEL,
  adminCan,
  adminFlagWired,
  type AdminFlagKey,
  type AdminFutureFlagKey,
} from '@pakdam/shared';
import { AdminApiError, listAdminFlags, saveAdminFlags } from '../../../lib/admin/admin-client';
import { readAdminSession } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import { Toggle } from '../../../components/ui/Toggle';
import {
  AdminCard,
  AdminDenied,
  AdminError,
  AdminLoading,
  Explainer,
} from '../../../components/admin/AdminUi';

export default function AdminFlagsPage() {
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canEdit = adminCan(role, 'flags.edit');
  // Future flags (billing.*/accounts.*) are Owner-only server-side
  // (PUT 403s for Admin/Staff) — the toggles below stay disabled
  // for non-Owners instead of offering a button that always fails.
  const isOwner = role === 'owner';
  const { data, loading, error, retry } = useAdminData(() => listAdminFlags());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // One flag per save (merge, 2026-11-27): the old code re-sent the
  // WHOLE list on every toggle, so an Admin flipping one game flag
  // also re-sent the future flags — and the server 403s any request
  // carrying a future flag from a non-Owner. A single-flag save
  // keeps game flags Admin-flippable now that GET /v1/admin/flags
  // returns the future rows too.
  const toggle = async (key: AdminFlagKey | AdminFutureFlagKey, enabled: boolean) => {
    if (!canEdit || !data) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await saveAdminFlags([{ key, enabled }]);
      setSaved(true);
      retry();
    } catch (err) {
      setSaveError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Feature switches</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          Turn features on or off. Changes apply at once — no deploy, no rebuild.
        </p>
      </div>

      {loading ? <AdminLoading what="feature switches" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {saveError ? (
        <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          Saved. The change is live now.
        </p>
      ) : null}
      {!canEdit ? <AdminDenied message={ADMIN_DENIED_MESSAGE} /> : null}

      {data
        ? ADMIN_FLAG_DEFS.map((def) => {
            const flag = data.find((f) => f.key === def.key);
            const enabled = flag?.enabled ?? false;
            return (
              <AdminCard key={def.key}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[15px] font-bold text-white">{def.label}</p>
                  <Toggle
                    checked={enabled}
                    label={def.label}
                    disabled={!canEdit || saving}
                    onChange={(checked) => toggle(def.key, checked)}
                  />
                </div>
                <Explainer>{def.explainer}</Explainer>
                {!adminFlagWired(def.key) ? (
                  <p className="mt-1 text-[13px] font-semibold text-[#F59E0B]">{ADMIN_PLACEBO_LABEL}</p>
                ) : null}
                <p className="mt-1 text-[13px] text-[#A1A1AA]">
                  Last changed by {flag?.updatedBy ?? '—'}
                  {flag?.updatedAt ? ` · ${new Date(flag.updatedAt).toLocaleString('en-IN')}` : ''}
                </p>
              </AdminCard>
            );
          })
        : null}

      {/* Future capabilities — billing & accounts (merge, 2026-11-27,
          Meera fix 1). These are NOT placebo flags: flipping one shows
          its section in the console. But the section stays honestly
          empty until the thing behind it exists — billing until a
          payment provider is connected, accounts until player accounts
          go live. Owner-only: only the Owner may activate a section
          nobody has approved. */}
      {data ? (
        <>
          <div className="mt-6">
            <h2 className="text-[17px] font-bold text-white">Future capabilities — billing &amp; accounts</h2>
            <p className="mt-1 text-[14px] text-[#A1A1AA]">
              Switching one on shows its section in the console. Billing stays unavailable until a payment provider
              is connected; accounts stay unavailable until player accounts go live. Only the Owner can switch these.
            </p>
          </div>
          {ADMIN_FUTURE_FLAGS.map((def) => {
            const flag = data.find((f) => f.key === def.key);
            const enabled = flag?.enabled ?? false;
            return (
              <AdminCard key={def.key}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[15px] font-bold text-white">{def.label}</p>
                  <Toggle
                    checked={enabled}
                    label={def.label}
                    disabled={!isOwner || saving}
                    onChange={(checked) => toggle(def.key, checked)}
                  />
                </div>
                <Explainer>{def.willDo}</Explainer>
                <p className="mt-1 text-[13px] text-[#A1A1AA]">{def.unlocksWhen}</p>
                {!isOwner ? (
                  <p className="mt-1 text-[13px] font-semibold text-[#F59E0B]">
                    Only the Owner can switch this on.
                  </p>
                ) : null}
                <p className="mt-1 text-[13px] text-[#A1A1AA]">
                  Last changed by {flag?.updatedBy ?? '—'}
                  {flag?.updatedAt ? ` · ${new Date(flag.updatedAt).toLocaleString('en-IN')}` : ''}
                </p>
              </AdminCard>
            );
          })}
        </>
      ) : null}
    </>
  );
}
