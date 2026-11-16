/**
 * Billing: the mode, plan enforcement, the Stripe client and the Stripe webhook.
 *
 * - Mode 'off' (default, self-hosted): no limits, every feature on. Mode 'stripe' is switched on when the server has
 *   Stripe keys (env STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET); switching starts a 14-day Pro trial.
 * - The Stripe API base URL is a constant, and requests go through the allow-list client (server/integrations/http.ts).
 *   Only tests point api.stripe.com at a mock, through buildApp's `billing.baseUrl` option; nothing a request sends can
 *   change where the server connects.
 * - The webhook checks Stripe-Signature (HMAC-SHA256 of `${t}.${body}` with the webhook secret, timing-safe, at most
 *   5 minutes old), applies each event id once (stripe_events) and only to this workspace's customer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tx, type Db } from './db';
import { AppError } from './errors';
import { now } from './auth';
import { accountRow } from './commands/rows';
import { featureAllowed, limitsFor, seatsUsed, TRIAL_DAYS, type BillingAccount, type Limits, type PlanFeature, type PlanType } from '../shared/plans';
import type { ChangeEvent } from './dispatch';
import { OutboundError, type OutboundClient, type OutboundResponse } from './integrations/http';

export const STRIPE_API = 'https://api.stripe.com';
/** Signed webhook timestamps older (or newer) than this are refused. */
export const WEBHOOK_TOLERANCE_S = 300;
/** Applied event ids are kept this long for replay protection. */
export const STRIPE_EVENT_KEEP_MS = 30 * 86_400_000;
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_MAX_RESPONSE = 1024 * 1024;

export interface BillingConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  /** Always STRIPE_API outside tests; a test's loopback mock for api.stripe.com otherwise (see buildApp). */
  baseUrl: string;
  /** Price ids by `<PLAN>_<INTERVAL>`, e.g. PRO_MONTH (env STRIPE_PRICE_PRO_MONTH). */
  prices: Record<string, string>;
}

/** Stripe settings from the environment; `over` is the test seam (buildApp's `billing` option). */
export function billingConfig(over: Partial<BillingConfig> = {}, env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const prices: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^STRIPE_PRICE_((?:PLUS|PRO)_(?:MONTH|YEAR))$/.exec(k);
    if (m && v) prices[m[1]] = v;
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY || null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    baseUrl: STRIPE_API,
    ...over,
    prices: over.prices ?? prices,
  };
}

export const stripeConfigured = (c: BillingConfig): boolean => !!c.secretKey && !!c.webhookSecret;

/**
 * The mode follows the server's configuration, at start and at setup: with Stripe keys 'stripe', without 'off' (all
 * unlocked; the plan columns stay for when the keys come back). The first switch to 'stripe' starts the Pro trial;
 * a workspace that had its trial keeps its plan.
 */
export function syncBillingMode(db: Db, configured: boolean): void {
  if (!configured) {
    db.prepare("UPDATE account SET billing_mode='off' WHERE billing_mode='stripe'").run();
    return;
  }
  const t = now();
  db.prepare("UPDATE account SET billing_mode='stripe', plan_type='pro', plan_status='trialing', trial_ends_at=?, trial_started_at=? WHERE billing_mode='off' AND trial_started_at IS NULL")
    .run(t + TRIAL_DAYS * 86_400_000, t);
  db.prepare("UPDATE account SET billing_mode='stripe' WHERE billing_mode='off'").run();
}

// ---------------------------------------------------------------------------------------------------------------
// Enforcement

const billingAccount = (db: Db): BillingAccount => accountRow(db) ?? {};
export const billingModeOf = (db: Db): string => (db.prepare('SELECT billing_mode m FROM account').get() as { m: string } | undefined)?.m ?? 'off';
export const accountLimits = (db: Db): Limits => limitsFor(billingAccount(db), now());

const SEAT_ROLES = new Set(['owner', 'admin', 'member']);
export const takesSeat = (role: string): boolean => SEAT_ROLES.has(role);

export function seatsInUse(db: Db): number {
  return seatsUsed(db.prepare('SELECT r.role role, u.disabled disabled, u.kind kind FROM account_roles r JOIN users u ON u.id=r.user_id').all() as { role: string; disabled: number; kind: string }[]);
}

/** 409 plan_feature when the plan lacks the feature (new writes only; existing values stay). */
export function assertFeature(db: Db, feature: PlanFeature): void {
  if (!featureAllowed(billingAccount(db), feature, now())) throw new AppError(409, 'plan_feature', { feature });
}

/** 409 plan_limit {limit:'users'} when one more person with `role` would exceed the seats. Observers and guests pass. */
export function assertSeatFor(db: Db, role: string): void {
  if (!takesSeat(role)) return;
  const { users } = accountLimits(db);
  if (users !== null && seatsInUse(db) >= users) throw new AppError(409, 'plan_limit', { limit: 'users' });
}

/** 409 plan_limit {limit:'projects'} when `adding` more live projects would exceed the plan. */
export function assertProjectSlots(db: Db, adding = 1): void {
  const { projects } = accountLimits(db);
  if (projects === null) return;
  const { n } = db.prepare('SELECT COUNT(*) n FROM projects WHERE is_archived=0').get() as { n: number };
  if (n + adding > projects) throw new AppError(409, 'plan_limit', { limit: 'projects' });
}

/** Upload room under the plan: the largest single file and the storage left (null = no plan cap). */
export function uploadRoom(db: Db): { fileBytes: number | null; storageLeft: number | null } {
  const { fileBytes, storageBytes } = accountLimits(db);
  if (storageBytes === null) return { fileBytes, storageLeft: null };
  // Attachments and covers (Open Deck banners and promo images are covers) share the plan's storage.
  const { used } = db.prepare('SELECT (SELECT COALESCE(SUM(size), 0) FROM files) + (SELECT COALESCE(SUM(size), 0) FROM covers) used').get() as { used: number };
  return { fileBytes, storageLeft: Math.max(0, storageBytes - used) };
}

/** The workspace MCP calls per UTC day: the lower of the setting and the plan (null = unlimited). */
export function mcpDailyLimit(db: Db, setting: number | null | undefined): number | null {
  const plan = accountLimits(db).mcpDaily;
  const s = setting ?? null;
  if (s === null) return plan;
  return plan === null ? s : Math.min(s, plan);
}

// ---------------------------------------------------------------------------------------------------------------
// Stripe API client (form-encoded requests, JSON responses)

type Form = Record<string, unknown>;

/** Stripe's bracket encoding: {a: {b: [ {c: 1} ]}} → a[b][0][c]=1. Null and undefined are left out. */
export function formEncode(obj: Form): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(obj, '');
  return out;
}

/** Stripe answered with an error status (sent to clients as 502 stripe_error; the status lets callers tell 404s apart). */
export class StripeError extends AppError {
  constructor(public stripeStatus: number) { super(502, 'stripe_error'); }
}

export class StripeClient {
  /** Requests go to STRIPE_API through the allow-list client; `http` maps api.stripe.com to a mock in tests only. */
  constructor(private cfg: Pick<BillingConfig, 'secretKey'>, private http: OutboundClient) {}

  private async call<T>(method: 'GET' | 'POST', path: string, params: Form = {}): Promise<T> {
    const form = formEncode(params);
    const url = `${STRIPE_API}${path}${method === 'GET' && [...form].length ? `?${form}` : ''}`;
    let res: OutboundResponse;
    try {
      res = await this.http.request(url, {
        method,
        timeoutMs: STRIPE_TIMEOUT_MS,
        maxBytes: STRIPE_MAX_RESPONSE,
        headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: method === 'POST' ? form.toString() : undefined,
      });
    } catch (e) {
      throw new AppError(502, e instanceof OutboundError && e.kind === 'too_large' ? 'stripe_error' : 'stripe_unavailable');
    }
    let json: any;
    try { json = JSON.parse(res.text); } catch { throw new AppError(502, 'stripe_error'); }
    if (!res.ok) {
      // The message only (never the request, which carries the key in its headers).
      console.error('[jt] stripe request failed', method, path, res.status, String(json?.error?.message ?? '').slice(0, 200));
      throw new StripeError(res.status);
    }
    return json as T;
  }

  createCheckoutSession(p: { price: string; quantity: number; customer: string | null; customerEmail: string | null; accountId: string; plan: string; successUrl: string; cancelUrl: string }) {
    return this.call<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: p.price, quantity: p.quantity }],
      customer: p.customer ?? undefined,
      customer_email: p.customer ? undefined : p.customerEmail ?? undefined,
      client_reference_id: p.accountId,
      metadata: { plan: p.plan, seats: p.quantity },
      subscription_data: { metadata: { plan: p.plan, account_id: p.accountId } },
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
    });
  }

  createPortalSession(customer: string, returnUrl: string) {
    return this.call<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl });
  }

  listInvoices(customer: string, limit: number) {
    return this.call<{ data: any[] }>('GET', '/v1/invoices', { customer, limit });
  }

  getSubscription(id: string) {
    return this.call<{ id: string; items: { data: { id: string; quantity?: number }[] } }>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  /** Cancel (true) or resume (false) a subscription at the end of its current period (Danger Zone disable / reactivate). */
  setCancelAtPeriodEnd(id: string, cancel: boolean) {
    return this.call<{ id: string }>('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: cancel });
  }

  setItemQuantity(itemId: string, quantity: number) {
    return this.call<{ id: string; quantity: number }>('POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, { quantity, proration_behavior: 'create_prorations' });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook

/** True when `header` (t=…,v1=…) signs `body` with `secret` and its timestamp is within the tolerance of `nowMs`. */
export function verifyStripeSignature(header: string | undefined, body: Buffer, secret: string, nowMs: number): boolean {
  if (!header || header.length > 2048) return false;
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't' && v && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
  const want = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
  return sigs.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), want));
}

/**
 * Stripe subscription status → plan_status. 'ended' drops the subscription (Free); unpaid and paused keep it on record
 * but count as canceled (Free limits) until Stripe reports it active again.
 */
const SUB_STATUS: Record<string, 'active' | 'past_due' | 'canceled' | 'ended'> = {
  active: 'active', trialing: 'active', past_due: 'past_due', incomplete: 'past_due',
  unpaid: 'canceled', paused: 'canceled', canceled: 'ended', incomplete_expired: 'ended',
};
const DROP_TO_FREE = "plan_type='free', plan_status='canceled', stripe_subscription_id=NULL, purchased_seats=0, billing_cycle_end=NULL, trial_ends_at=NULL";

const asPlan = (v: unknown): PlanType | null => (v === 'plus' || v === 'pro' ? v : null);

/** The plan of a price id (reverse of the configured prices), else the plan in the metadata. */
function planOfSubscription(cfg: BillingConfig, sub: any): PlanType | null {
  const price = sub?.items?.data?.[0]?.price?.id;
  for (const [key, id] of Object.entries(cfg.prices)) if (id === price) return asPlan(key.split('_')[0].toLowerCase());
  return asPlan(sub?.metadata?.plan);
}

const intOr = (v: unknown, d: number | null) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d);

/**
 * Verifies and applies one webhook delivery. 400 bad_signature (nothing changes) or 400 invalid_payload; a replayed or
 * foreign event is acknowledged without effect. Returns the change events to publish.
 */
export function handleStripeWebhook(db: Db, cfg: BillingConfig, body: Buffer, signature: string | undefined): ChangeEvent[] {
  if (!cfg.webhookSecret || !verifyStripeSignature(signature, body, cfg.webhookSecret, now())) throw new AppError(400, 'bad_signature');
  let ev: any;
  try { ev = JSON.parse(body.toString('utf8')); } catch { throw new AppError(400, 'invalid_payload'); }
  if (typeof ev?.id !== 'string' || typeof ev?.type !== 'string' || typeof ev?.data?.object !== 'object' || !ev.data.object) throw new AppError(400, 'invalid_payload');
  const obj = ev.data.object;
  return tx(db, () => {
    if (billingModeOf(db) !== 'stripe') return [];
    const fresh = db.prepare('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?,?,?)').run(ev.id.slice(0, 255), ev.type.slice(0, 100), now());
    if (!fresh.changes) return [];
    const acc = db.prepare('SELECT id, stripe_customer_id c, stripe_subscription_id s FROM account').get() as { id: string; c: string | null; s: string | null } | undefined;
    if (!acc) return [];
    // Our customer, or (before one is recorded) a subscription made by our checkout (its metadata names this workspace).
    const ownsCustomer = (o: any) => typeof o.customer === 'string' && (acc.c ? o.customer === acc.c : o.metadata?.account_id === acc.id);
    let changed = false;
    const set = (sql: string, ...args: (string | number | null)[]) => { changed = db.prepare(`UPDATE account SET ${sql}`).run(...args).changes > 0 || changed; };
    switch (ev.type) {
      case 'checkout.session.completed': {
        if (obj.client_reference_id !== acc.id || typeof obj.customer !== 'string') break;
        const sub = typeof obj.subscription === 'string' ? obj.subscription : null;
        // Another subscription is already on record (startCheckout refuses that case): leave it alone.
        if (acc.s && sub && sub !== acc.s) break;
        set('stripe_customer_id=?, stripe_subscription_id=COALESCE(?, stripe_subscription_id)', obj.customer, sub);
        // Not paid yet (e.g. a delayed payment method): the subscription events bring the status later.
        if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') break;
        set("plan_status='active', trial_ends_at=NULL");
        const plan = asPlan(obj.metadata?.plan);
        if (plan) set('plan_type=?, purchased_seats=?', plan, intOr(Number(obj.metadata?.seats), 0) ?? 0);
        break;
      }
      case 'customer.subscription.updated': {
        if (typeof obj.id !== 'string') break;
        const status = SUB_STATUS[String(obj.status)] ?? 'past_due';
        // The recorded subscription only; with none recorded, a live one of ours is adopted (it may arrive before
        // checkout.session.completed).
        if (acc.s ? obj.id !== acc.s : status === 'ended' || !ownsCustomer(obj)) break;
        if (status === 'ended') { set(DROP_TO_FREE); break; }
        if (!acc.c) set('stripe_customer_id=?', obj.customer);
        const item = obj.items?.data?.[0];
        const end = intOr(obj.current_period_end ?? item?.current_period_end, null);
        const plan = planOfSubscription(cfg, obj);
        set('stripe_subscription_id=?, plan_status=?, purchased_seats=COALESCE(?, purchased_seats), billing_cycle_end=?, trial_ends_at=NULL',
          obj.id, status, intOr(item?.quantity, null), end === null ? null : end * 1000);
        if (plan) set('plan_type=?', plan);
        break;
      }
      case 'customer.subscription.deleted':
        if (acc.s && obj.id === acc.s) set(DROP_TO_FREE);
        break;
      case 'invoice.payment_failed': {
        const sub = obj.subscription ?? obj.parent?.subscription_details?.subscription;
        if (acc.s && sub === acc.s) set("plan_status='past_due' WHERE plan_status='active'");
        break;
      }
    }
    return changed ? [{ model: 'account', op: 'upsert', row: accountRow(db) } as ChangeEvent] : [];
  });
}

/** Raw Stripe ids of the workspace (never sent to clients). */
export function stripeIds(db: Db): { accountId: string; customer: string | null; subscription: string | null } {
  const r = db.prepare('SELECT id, stripe_customer_id c, stripe_subscription_id s FROM account').get() as { id: string; c: string | null; s: string | null };
  return { accountId: r.id, customer: r.c, subscription: r.s };
}
