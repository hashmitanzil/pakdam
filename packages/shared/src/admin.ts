/**
 * Admin Console ("Mission Control") — shared contract.
 *
 * This is the SINGLE permission matrix for the admin panel. The web
 * client imports it for UI gating (which nav items and buttons to
 * show); the Worker MUST import it too and enforce it server-side on
 * every /v1/admin/* route. The client gate is usability only — never
 * trust the client for enforcement; the server is the authority.
 *
 * NOTE (Meera, 2026-11-25): this file did not exist when the web
 * track started — Kabir's server half had not landed it yet. It is
 * written here so the client has one source of truth to import, and
 * Kabir should import this same file on the server rather than
 * re-defining the matrix. If the server's matrix ever disagrees with
 * this file, the server wins and this file must be updated to match.
 *
 * Roles (founder decision, 2026-11-25):
 * - owner — the founder. Everything, including live locations, role
 *   management and user accounts. The last Owner can never be
 *   demoted or deleted (server enforces; the UI refuses too).
 * - admin — end/cancel/force-results, kick/block, feature switches,
 *   game config, announcements. NO exact live locations, no user
 *   management, no role management.
 * - staff — view-only, plus creating flags/reports. Cannot kick,
 *   end, configure, switch features, or manage users.
 */

/** Admin account roles. */
export type AdminRole = 'owner' | 'admin' | 'staff';

/** Every gated capability in the console. */
export type AdminPermission =
  | 'view.overview'
  | 'view.rooms'
  | 'view.players'
  | 'view.flags'
  | 'view.config'
  | 'view.safety'
  | 'view.costs'
  | 'view.numbers'
  | 'view.audit'
  | 'view.announcements'
  | 'view.users'
  | 'view.billing'
  | 'view.accounts'
  | 'rooms.end'
  | 'rooms.cancel'
  | 'rooms.forceResults'
  | 'players.kick'
  | 'players.block'
  | 'players.unblock'
  | 'players.viewLocation'
  | 'players.erase'
  | 'flags.edit'
  | 'config.edit'
  | 'safety.createFlag'
  | 'safety.unblock'
  | 'announcements.edit'
  | 'users.manage'
  | 'users.changePassword';

/**
 * The matrix. One row per permission, one column per role.
 * Keep this flat and explicit — a missing entry is a denial, never
 * an accidental grant.
 */
export const ADMIN_PERMISSIONS: Record<AdminPermission, Readonly<Record<AdminRole, boolean>>> = {
  'view.overview': { owner: true, admin: true, staff: true },
  'view.rooms': { owner: true, admin: true, staff: true },
  'view.players': { owner: true, admin: true, staff: true },
  'view.flags': { owner: true, admin: true, staff: true },
  'view.config': { owner: true, admin: true, staff: true },
  'view.safety': { owner: true, admin: true, staff: true },
  'view.costs': { owner: true, admin: true, staff: true },
  'view.numbers': { owner: true, admin: true, staff: true },
  'view.audit': { owner: true, admin: true, staff: true },
  'view.announcements': { owner: true, admin: true, staff: true },
  'view.users': { owner: true, admin: false, staff: false },
  'view.billing': { owner: true, admin: true, staff: false },
  'view.accounts': { owner: true, admin: true, staff: true },
  'rooms.end': { owner: true, admin: true, staff: false },
  'rooms.cancel': { owner: true, admin: true, staff: false },
  'rooms.forceResults': { owner: true, admin: true, staff: false },
  'players.kick': { owner: true, admin: true, staff: false },
  'players.block': { owner: true, admin: true, staff: false },
  'players.unblock': { owner: true, admin: true, staff: false },
  'players.viewLocation': { owner: true, admin: false, staff: false },
  // Kabir (server, fix round 2026-11-25, item 9): erasure used to be
  // a direct Owner role check in the handler — it is a matrix
  // permission now, like everything else. Owner-only.
  'players.erase': { owner: true, admin: false, staff: false },
  'flags.edit': { owner: true, admin: true, staff: false },
  'config.edit': { owner: true, admin: true, staff: false },
  'safety.createFlag': { owner: true, admin: true, staff: true },
  'safety.unblock': { owner: true, admin: true, staff: false },
  'announcements.edit': { owner: true, admin: true, staff: false },
  'users.manage': { owner: true, admin: false, staff: false },
  // Kabir (server, fix round 2026-11-26, B3 re-review): password
  // change is SELF-SERVICE for every role — any signed-in admin may
  // change their OWN password only. The endpoint operates solely on
  // the caller's session identity (gate.user.id); it takes no
  // target-user parameter, so there is no way to change anyone
  // else's password through it. Owner-only gating here was the
  // defect: Owner-created Admin/Staff accounts are born with
  // must_change_password=true and could never clear the flag.
  'users.changePassword': { owner: true, admin: true, staff: true },
};

/** True when `role` may do `permission`. Unknown roles/keys deny. */
export function adminCan(role: AdminRole | string | null | undefined, permission: AdminPermission): boolean {
  if (role !== 'owner' && role !== 'admin' && role !== 'staff') return false;
  // Kabir (server, 2026-11-25) — bug fix: an unknown permission key
  // used to throw (undefined[role]) instead of denying, contradicting
  // this function's own "Unknown roles/keys deny" contract. Deny.
  return ADMIN_PERMISSIONS[permission]?.[role] === true;
}

/** Plain-words copy for a denied action — shown, never a crash, never silence. */
export const ADMIN_DENIED_MESSAGE = "You don't have permission for this.";
/** The visible notice shown with any Owner-only live-location view. */
export const ADMIN_LOCATION_NOTICE =
  'Live location is shown in-session only. It is never stored, logged or exported.';
/** Generic setup-failure copy — never says whether the token or the account was the problem. */
export const ADMIN_SETUP_FAILED_MESSAGE = 'Setup failed — check the setup token and try again.';
/** Honest copy for a seat block: a block binds to the seat's stored sign-in only. */
export const ADMIN_BAN_HONEST_COPY =
  "Blocks this seat's stored sign-in. A player on a fresh device can rejoin.";
/** Costs copy when the DO meter cannot be measured (never a green/ok state from an unknown meter). */
export const ADMIN_UNKNOWN_METER_COPY = 'Usage unknown — check the Cloudflare dashboard';
/** Label for a console switch the game does not consume yet. */
export const ADMIN_PLACEBO_LABEL = 'Not connected yet — changing this does nothing in the game today.';
/** Same label for game config values the game never reads. */
export const ADMIN_CONFIG_PLACEBO_LABEL = 'Not connected yet — changing these settings does nothing in the game today.';

/**
 * Which console feature flags the game actually consumes today
 * (verified against the server: `radio` in workers/src/
 * room-do-class.ts, `gameStart` in workers/src/http.ts — the start
 * kill-switch, wired to the flags-page toggle).
 * Every other flag in ADMIN_FLAG_DEFS is a placebo until wired:
 * the console can flip it, but the game never reads it.
 * NOTE (merge, 2026-11-27 — Meera fix 2): `gameStart` IS wired —
 * handleStart and the lifecycle `start` refuse new matches when it
 * is OFF — so it belongs here. The flags page must never call it a
 * toggling it off is blocking all new games, and the label must
 * say so.
 */
export const ADMIN_WIRED_FLAGS: readonly AdminFlagKey[] = ['radio', 'gameStart'];

/** True when flipping this flag actually changes the game today. */
export function adminFlagWired(key: AdminFlagKey): boolean {
  return (ADMIN_WIRED_FLAGS as readonly string[]).includes(key);
}

/** Minimum admin password length — the server enforces 12 too. */
export const ADMIN_MIN_PASSWORD_LENGTH = 12;

/** Plain-words password-policy copy for setup / create-user forms. */
export const ADMIN_PASSWORD_POLICY_COPY = 'Use at least 12 characters.';

/** Plain-words validation for an admin password. Null = valid. */
export function adminPasswordError(password: string): string | null {
  if (password.length < ADMIN_MIN_PASSWORD_LENGTH) {
    return `Too short — use at least ${ADMIN_MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
export const ADMIN_DENIED_USERS_MESSAGE =
  'Only the Owner can manage accounts. Ask the Owner to make this change.';

/** Admin nav — one entry per console page, gated by its permission. */
export interface AdminNavItem {
  href: string;
  label: string;
  blurb: string;
  permission: AdminPermission;
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/admin', label: 'Overview', blurb: 'Live games and platform health', permission: 'view.overview' },
  { href: '/admin/rooms', label: 'Rooms', blurb: 'Live and recent games', permission: 'view.rooms' },
  { href: '/admin/players', label: 'Players', blurb: 'Who is playing now', permission: 'view.players' },
  { href: '/admin/flags', label: 'Feature switches', blurb: 'Turn features on or off', permission: 'view.flags' },
  { href: '/admin/config', label: 'Game settings', blurb: 'Default round and zone settings', permission: 'view.config' },
  { href: '/admin/safety', label: 'Safety', blurb: 'Reports, blocks and abuse flags', permission: 'view.safety' },
  { href: '/admin/costs', label: 'Costs & limits', blurb: 'Usage against the daily cap', permission: 'view.costs' },
  { href: '/admin/numbers', label: 'Numbers', blurb: 'Games, players and catches', permission: 'view.numbers' },
  { href: '/admin/audit', label: 'Audit log', blurb: 'Every action in this panel', permission: 'view.audit' },
  { href: '/admin/announcements', label: 'Announcements', blurb: 'Messages on the home screen', permission: 'view.announcements' },
  { href: '/admin/users', label: 'Users', blurb: 'Admin and Staff accounts', permission: 'view.users' },
  { href: '/admin/billing', label: 'Payments & billing', blurb: 'Plans, transactions and payouts', permission: 'view.billing' },
  { href: '/admin/accounts', label: 'Users & accounts', blurb: 'Player accounts and data requests', permission: 'view.accounts' },
  // Fix round 2 (2026-11-26): the always-visible escape route for a
  // flagged account. `users.changePassword` is true for every role,
  // so Owner, Admin and Staff all see this — a flagged Admin/Staff
  // is redirected away from /admin/users and would otherwise have
  // no in-panel path to the change page at all.
  { href: '/admin/change-password', label: 'Change password', blurb: 'Change your own password', permission: 'users.changePassword' },
];

/** Nav items visible to `role`. */
export function adminNavFor(role: AdminRole | string | null | undefined): AdminNavItem[] {
  return ADMIN_NAV.filter((item) => adminCan(role, item.permission));
}

/** Human label for a role. */
export function adminRoleLabel(role: AdminRole | string | null | undefined): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  if (role === 'staff') return 'Staff';
  return 'Signed out';
}

/** A signed-in admin identity, as returned by GET /v1/admin/auth/me. */
export interface AdminMe {
  username: string;
  role: AdminRole;
  /** Set by the server for accounts that must change password on first sign-in. Absent = no forced change. */
  mustChangePassword?: boolean;
}

/** Feature flags the console can switch without a deploy. */
export type AdminFlagKey = 'radio' | 'pings' | 'zone' | 'demoMode' | 'voiceText' | 'qrInvite' | 'gameStart';

export interface AdminFlag {
  /** Game flags come from ADMIN_FLAG_DEFS; future flags
   * (billing.* and accounts.*) from ADMIN_FUTURE_FLAGS — GET
   * /v1/admin/flags returns both, so the flags page can list and
   * flip the future ones too (Owner-only). */
  key: AdminFlagKey | AdminFutureFlagKey;
  label: string;
  explainer: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const ADMIN_FLAG_DEFS: readonly { key: AdminFlagKey; label: string; explainer: string }[] = [
  { key: 'radio', label: 'Radio (voice)', explainer: 'Lets players talk to teammates during a game.' },
  { key: 'pings', label: 'Opponent pings', explainer: 'Shows a short ping where an opponent was seen.' },
  { key: 'zone', label: 'Play zone', explainer: 'Shrinks the play area as the game goes on.' },
  { key: 'demoMode', label: 'Demo mode', explainer: 'Lets a phone try the game alone, without a live room.' },
  { key: 'voiceText', label: 'Radio text fallback', explainer: 'Shows typed radio messages when voice cannot play.' },
  { key: 'qrInvite', label: 'QR invite', explainer: 'Lets the host share a QR code to join the lobby.' },
  // Kabir (server, 2026-11-25) — contract ADDITION, reported to the coordinator: the game-start kill-switch.
  // The Worker consults it server-side before any match starts (workers/src/http.ts handleStart); when OFF,
  // no new match may start while live games are untouched. It is a flag, not a deploy.
  { key: 'gameStart', label: 'New games', explainer: 'When off, no new match can start. Games already running are not affected.' },
];

/** Game defaults the console edits (steppers only in the UI). */
export interface AdminGameConfig {
  /** Round length in minutes; 5–180. */
  roundLengthMinutes: number;
  /** Head start in minutes; 0–30. */
  headStartMinutes: number;
  /** Ping interval in minutes; 0 = no pings, else 1–30. */
  pingIntervalMinutes: number;
  /** Default zone radius in metres; 100–5000. */
  zoneRadiusMetres: number;
  /** Seconds between zone shrinks; 60–1800. */
  shrinkEverySeconds: number;
  /** Zone shrinking on by default. */
  zoneShrinkEnabled: boolean;
}

export const ADMIN_CONFIG_LIMITS = {
  roundLengthMinutes: { min: 5, max: 180 },
  headStartMinutes: { min: 0, max: 30 },
  pingIntervalMinutes: { min: 0, max: 30 },
  zoneRadiusMetres: { min: 100, max: 5000 },
  shrinkEverySeconds: { min: 60, max: 1800 },
} as const;

export const ADMIN_CONFIG_DEFAULTS: AdminGameConfig = {
  roundLengthMinutes: 30,
  headStartMinutes: 3,
  pingIntervalMinutes: 3,
  zoneRadiusMetres: 500,
  shrinkEverySeconds: 600,
  zoneShrinkEnabled: true,
};

/** Plain-words validation for a game-config value. Null = valid. */
export function adminConfigError(key: keyof typeof ADMIN_CONFIG_LIMITS, value: number): string | null {
  const limits = ADMIN_CONFIG_LIMITS[key];
  if (!Number.isFinite(value)) return 'Enter a whole number.';
  if (!Number.isInteger(value)) return 'Enter a whole number, not a decimal.';
  if (value < limits.min) return `Too small — the smallest allowed is ${limits.min}.`;
  if (value > limits.max) return `Too big — the largest allowed is ${limits.max}.`;
  return null;
}

/** The announcement shown as a banner on the game home screen. */
export interface AdminAnnouncement {
  id: string;
  message: string;
  active: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The one announcement the public home page shows (active, newest first). */
export function pickPublicAnnouncement(announcements: AdminAnnouncement[]): AdminAnnouncement | null {
  const active = announcements.filter((a) => a.active && a.message.trim().length > 0);
  if (active.length === 0) return null;
  active.sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''));
  return active[0] ?? null;
}

/** True when the banner should show: an active announcement the player has not dismissed this session. */
export function shouldShowAnnouncement(
  announcement: { id: string; message: string; active: boolean } | null,
  dismissedId: string | null,
): boolean {
  if (!announcement || !announcement.active) return false;
  if (!announcement.message.trim()) return false;
  if (dismissedId !== null && dismissedId === announcement.id) return false;
  return true;
}

/** Daily-cap alert state for the Costs page (in-app counters only). */
export function adminCapAlertState(usedToday: number, dailyCap: number): 'ok' | 'watch' | 'near-cap' {
  if (dailyCap <= 0) return 'ok';
  const ratio = usedToday / dailyCap;
  if (ratio >= 0.9) return 'near-cap';
  if (ratio >= 0.75) return 'watch';
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* Future capabilities — Payments & Billing + Users & Accounts.        */
/*                                                                     */
/* Founder scope addition, 2026-11-25 ~19:09 IST: "add the payments/  */
/* billing and the user/account management as well… the features not   */
/* active will just say not available at the moment / future upgrades."*/
/*                                                                     */
/* Pakdam TODAY has no payments (free, no provider connected) and no   */
/* user accounts (guest-only, codenames + device keys, no login). The  */
/* v2 track holds the future pieces as scaffolding only — Host Pass    */
/* ₹299 one-time (legal gate before ANY sale) and the optional free    */
/* login (Google / email magic link, no phone OTP).                    */
/*                                                                     */
/* RULES: no live billing or accounts now, no provider SDKs/keys, no   */
/* fake numbers, no invented transactions or users. Every inactive     */
/* capability renders the shared NotAvailable state and is gated by    */
/* ONE feature flag per capability, default OFF. Activation later is   */
/* a flag flip, not a rebuild — the UI is designed compliant now       */
/* (data minimisation, no invented identity fields, no raw coords).    */
/* ------------------------------------------------------------------ */

/** The one shared not-available line — identical copy everywhere. */
export const FUTURE_UPGRADE_MESSAGE = 'Not available at the moment — future upgrade.';

/** One flag per future capability. Default OFF. Read from the API. */
export type AdminFutureFlagKey =
  | 'billing.overview'
  | 'billing.transactions'
  | 'billing.plans'
  | 'billing.providers'
  | 'billing.refunds'
  | 'billing.tax'
  | 'accounts.directory'
  | 'accounts.roles'
  | 'accounts.bans'
  | 'accounts.dataRequests'
  | 'accounts.loginMethods';

export interface AdminFutureFlag {
  key: AdminFutureFlagKey;
  /** Plain label for the flags page (e.g. 'Billing — overview'). */
  label: string;
  /** What unlocks this capability, in one plain line. */
  unlocksWhen: string;
  /** What this capability will do, in one plain line. */
  willDo: string;
  enabled: boolean;
}

export const ADMIN_FUTURE_FLAGS: readonly AdminFutureFlag[] = [
  {
    key: 'billing.overview',
    label: 'Billing — overview',
    unlocksWhen: 'Activates when the first payment goes live.',
    willDo: 'Shows revenue, transactions and refunds for the platform.',
    enabled: false,
  },
  {
    key: 'billing.transactions',
    label: 'Billing — transactions',
    unlocksWhen: 'Activates when the first payment goes live.',
    willDo: 'Lists every payment, its status and its receipt.',
    enabled: false,
  },
  {
    key: 'billing.plans',
    label: 'Billing — plans',
    unlocksWhen: 'Activates when Host Pass goes on sale after the legal gate.',
    willDo: 'Shows the plans and passes players can buy.',
    enabled: false,
  },
  {
    key: 'billing.providers',
    label: 'Billing — providers',
    unlocksWhen: 'Activates when a payment provider is connected.',
    willDo: 'Shows which payment methods players can use.',
    enabled: false,
  },
  {
    key: 'billing.refunds',
    label: 'Billing — refunds',
    unlocksWhen: 'Activates when the first payment goes live.',
    willDo: 'Lists refund requests and their outcomes.',
    enabled: false,
  },
  {
    key: 'billing.tax',
    label: 'Billing — tax',
    unlocksWhen: 'Activates when the first payment goes live.',
    willDo: 'Shows GST invoices, tax collected and payouts.',
    enabled: false,
  },
  {
    key: 'accounts.directory',
    label: 'Accounts — directory',
    unlocksWhen: 'Activates when player accounts go live.',
    willDo: 'Lists every player account, its status and its games.',
    enabled: false,
  },
  {
    key: 'accounts.roles',
    label: 'Accounts — roles',
    unlocksWhen: 'Activates when player accounts go live.',
    willDo: 'Shows and changes what a player account can do.',
    enabled: false,
  },
  {
    key: 'accounts.bans',
    label: 'Accounts — bans',
    unlocksWhen: 'Account bans arrive with player accounts. Device bans are live now, in Safety.',
    willDo: 'Bans or suspends a player account so it cannot play.',
    enabled: false,
  },
  {
    key: 'accounts.dataRequests',
    label: 'Accounts — data requests',
    unlocksWhen: 'Activates when player accounts go live.',
    willDo: 'Handles access, correction and erasure requests under the DPDP Act.',
    enabled: false,
  },
  {
    key: 'accounts.loginMethods',
    label: 'Accounts — login methods',
    unlocksWhen: 'Activates when the free login feature goes live.',
    willDo: 'Shows how a player signs in — Google or email link, no phone OTP.',
    enabled: false,
  },
];

/**
 * Live state of one future flag from a fetched flag list (the
 * GET /v1/admin/flags rows). False when the flag is absent — a
 * missing row means OFF, never ON. Pure, so pages and tests can
 * pin the branch without a fetch.
 */
export function adminFutureFlagEnabled(
  flags: readonly { key: string; enabled: boolean }[] | null | undefined,
  key: AdminFutureFlagKey,
): boolean {
  return flags?.find((f) => f.key === key)?.enabled === true;
}

/** Look up one future flag's copy (unlock line + what-it-will-do). */
export function adminFutureFlag(key: AdminFutureFlagKey): AdminFutureFlag {
  return (
    ADMIN_FUTURE_FLAGS.find((f) => f.key === key) ?? {
      key,
      label: key,
      unlocksWhen: 'Activates in a future upgrade.',
      willDo: '',
      enabled: false,
    }
  );
}

/**
 * Host Pass — the v2 track's planned one-time pass. Shown as PLANNED,
 * never as on sale: the legal gate must pass before ANY sale.
 */
export const HOST_PASS_PLAN = {
  name: 'Host Pass',
  pricePaise: 29900,
  priceLabel: '₹299',
  billing: 'One-time',
  status: 'planned' as const,
  statusCopy: 'Planned — not on sale. Legal gate pending.',
} as const;

/** Bans/suspensions of a DEVICE key are REAL today (Safety blocks API);
 * bans of a player ACCOUNT are future — the flag above gates the
 * account-level view, not the device action. */
export type AdminBanAction = 'ban' | 'suspend' | 'unban';

