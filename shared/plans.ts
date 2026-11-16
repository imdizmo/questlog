/**
 * Plans and what they allow. Shared by the server (enforcement) and the web client (Billing tab, read-only fields).
 *
 * - Billing mode 'off' (self-hosted, the default): everything is unlimited and every feature is on, as on Enterprise.
 * - Billing mode 'stripe': the account's plan applies. A running trial counts as Pro; an expired trial or a
 *   canceled subscription counts as Free (the trial job in server/jobs.ts also writes that down).
 * - `planOverwrites` (set by an operator) replaces single limits and may add features, for one workspace.
 * - Observers and guests take no seat. The Observer role itself needs Plus or Pro.
 */
export type PlanType = 'free' | 'plus' | 'pro' | 'enterprise';
export type PlanStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type BillingMode = 'off' | 'stripe';
export type PlanFeature = 'dueDates' | 'timeTracking' | 'dependencies' | 'limitedVisibility' | 'guardians' | 'observerRole';
/** Features only Pro (and Enterprise, and billing mode off) include. */
export const PRO_FEATURES: readonly PlanFeature[] = ['dueDates', 'timeTracking', 'dependencies', 'limitedVisibility', 'guardians'];
/** Every gated feature: the Pro ones plus the Observer role (Plus and Pro). */
export const ALL_FEATURES: readonly PlanFeature[] = [...PRO_FEATURES, 'observerRole'];
export const TRIAL_DAYS = 14;

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface PlanDef {
  label: string;
  /** Seats (owners, admins, members); null = unlimited. */
  users: number | null;
  /** Live (not archived) projects; null = unlimited. */
  projects: number | null;
  /** Total attachment storage; multiplied by the seats when `perUser`. */
  storageBytes: number | null;
  /** Largest single attachment. */
  fileBytes: number | null;
  /** MCP tool calls per UTC day for the workspace; multiplied by the seats when `perUser`. */
  mcpDaily: number | null;
  perUser: boolean;
  features: readonly PlanFeature[];
}

export const PLANS: Record<PlanType, PlanDef> = {
  free: { label: 'Free', users: 5, projects: 3, storageBytes: GB, fileBytes: 10 * MB, mcpDaily: 100, perUser: false, features: [] },
  plus: { label: 'Plus', users: null, projects: null, storageBytes: GB, fileBytes: 250 * MB, mcpDaily: 250, perUser: true, features: ['observerRole'] },
  pro: { label: 'Pro', users: null, projects: null, storageBytes: 10 * GB, fileBytes: 250 * MB, mcpDaily: null, perUser: true, features: ALL_FEATURES },
  enterprise: { label: 'Enterprise', users: null, projects: null, storageBytes: null, fileBytes: null, mcpDaily: null, perUser: false, features: ALL_FEATURES },
};

export interface Limits {
  /** The plan in force (a running trial is 'pro'; mode off is 'enterprise'). */
  plan: PlanType;
  users: number | null;
  projects: number | null;
  storageBytes: number | null;
  fileBytes: number | null;
  mcpDaily: number | null;
  features: PlanFeature[];
}

/** Operator overrides for one workspace: any limit (null = unlimited) and extra features. */
export interface PlanOverwrites {
  users?: number | null;
  projects?: number | null;
  storageBytes?: number | null;
  fileBytes?: number | null;
  mcpDaily?: number | null;
  features?: PlanFeature[];
}

/** The billing fields of an account row (camelCase, as the server and the client hold it). */
export interface BillingAccount {
  billingMode?: BillingMode | string | null;
  planType?: PlanType | string | null;
  planStatus?: PlanStatus | string | null;
  trialEndsAt?: number | null;
  purchasedSeats?: number | null;
  planOverwrites?: PlanOverwrites | null;
}

const isPlan = (p: unknown): p is PlanType => typeof p === 'string' && Object.hasOwn(PLANS, p);

/** The plan in force at `now`. */
export function effectivePlan(a: BillingAccount, now = Date.now()): PlanType {
  if (a.billingMode !== 'stripe') return 'enterprise';
  if (a.planStatus === 'trialing') return a.trialEndsAt != null && a.trialEndsAt > now ? 'pro' : 'free';
  if (a.planStatus === 'canceled') return 'free';
  return isPlan(a.planType) ? a.planType : 'free';
}

const times = (v: number | null, n: number) => (v === null ? null : v * n);
const OVERWRITE_KEYS = ['users', 'projects', 'storageBytes', 'fileBytes', 'mcpDaily'] as const;

/** What the workspace may use at `now`: the plan, its seats (paid plans), the trial, the mode and `planOverwrites`. */
export function limitsFor(a: BillingAccount, now = Date.now()): Limits {
  const plan = effectivePlan(a, now);
  const def = PLANS[plan];
  if (plan === 'enterprise' && a.billingMode !== 'stripe') {
    return { plan, users: null, projects: null, storageBytes: null, fileBytes: null, mcpDaily: null, features: [...ALL_FEATURES] };
  }
  const bought = Math.max(0, Math.floor(Number(a.purchasedSeats) || 0));
  const seats = Math.max(1, bought);
  // A paid subscription has as many seats as were bought (at least 1); the trial and Free use the plan's own number.
  const paid = (plan === 'plus' || plan === 'pro') && a.planStatus !== 'trialing';
  const out: Limits = {
    plan,
    users: paid ? seats : def.users,
    projects: def.projects,
    storageBytes: def.perUser ? times(def.storageBytes, seats) : def.storageBytes,
    fileBytes: def.fileBytes,
    mcpDaily: def.perUser ? times(def.mcpDaily, seats) : def.mcpDaily,
    features: [...def.features],
  };
  const ow = a.planOverwrites && typeof a.planOverwrites === 'object' ? a.planOverwrites : {};
  for (const k of OVERWRITE_KEYS) {
    const v = ow[k];
    if (v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) out[k] = v;
  }
  if (Array.isArray(ow.features)) {
    for (const f of ow.features) if (ALL_FEATURES.includes(f) && !out.features.includes(f)) out.features.push(f);
  }
  return out;
}

export function featureAllowed(a: BillingAccount, feature: PlanFeature, now = Date.now()): boolean {
  return limitsFor(a, now).features.includes(feature);
}

/** Seats in use: active owners, admins and members (observers, guests, disabled people and service users take none). */
export function seatsUsed(users: Iterable<{ role: string; disabled?: boolean | number | null; kind?: string | null }>): number {
  let n = 0;
  for (const u of users) {
    if (u.disabled || (u.kind && u.kind !== 'person')) continue;
    if (u.role === 'owner' || u.role === 'admin' || u.role === 'member') n++;
  }
  return n;
}

/** Whole days left in a running trial (0 when it has ended or there is none). */
export function trialDaysLeft(a: BillingAccount, now = Date.now()): number {
  if (a.planStatus !== 'trialing' || a.trialEndsAt == null) return 0;
  return Math.max(0, Math.ceil((a.trialEndsAt - now) / 86_400_000));
}
