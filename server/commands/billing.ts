/**
 * Billing commands (POST /dispatch/billing/<action>). They call Stripe, so they run outside the synchronous command
 * registry, each with the same checks a command gets: never for API tokens (403, the `billing` namespace is
 * token-denied), owners and admins only (account.manage), and 409 billing_off while the workspace is self-hosted.
 */
import { z, type ZodType } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { assertCan, type Actor } from '../permissions';
import { assertTokenScope, nextActionId, toActor, type ChangeEvent } from '../dispatch';
import { accountRow } from './rows';
import { billingModeOf, seatsInUse, stripeIds, type BillingConfig, type StripeClient } from '../billing';
import type { User } from '../../shared/types';

export const INVOICE_LIMIT = 24;
const MAX_SEATS = 10_000;

export interface BillingDeps {
  cfg: BillingConfig;
  /** Null when the server has no Stripe keys. */
  client: StripeClient | null;
  /** Absolute URL of the workspace settings, for Stripe's return links. */
  returnUrl: string;
}

interface Run { db: Db; actor: Actor; client: StripeClient; deps: BillingDeps; events: ChangeEvent[] }
interface BillingCommand<T = any> { schema: ZodType<T>; run(r: Run, input: T): Promise<unknown> }

const seatsSchema = z.number().int().min(1).max(MAX_SEATS);

/** At least as many seats as are in use. */
function assertSeatsCover(db: Db, seats: number): void {
  if (seats < seatsInUse(db)) throw new AppError(409, 'plan_limit', { limit: 'users' });
}

export const billingCommands: Record<string, BillingCommand> = {
  'billing/startCheckout': {
    schema: z.object({ plan: z.enum(['plus', 'pro']), interval: z.enum(['month', 'year']), seats: seatsSchema }),
    async run({ db, actor, client, deps }, { plan, interval, seats }) {
      // A second subscription would bill twice: plan and seat changes go through the portal (or setSeats).
      if (stripeIds(db).subscription) throw new AppError(409, 'already_subscribed');
      assertSeatsCover(db, seats);
      const price = deps.cfg.prices[`${plan.toUpperCase()}_${interval.toUpperCase()}`];
      if (!price) throw new AppError(409, 'price_missing', { plan, interval });
      const ids = stripeIds(db);
      const email = (db.prepare('SELECT email FROM users WHERE id=?').get(actor.id) as { email: string } | undefined)?.email ?? null;
      const s = await client.createCheckoutSession({
        price, quantity: seats, customer: ids.customer, customerEmail: email, accountId: ids.accountId, plan,
        successUrl: `${deps.returnUrl}&billing=done`, cancelUrl: deps.returnUrl,
      });
      if (typeof s?.url !== 'string') throw new AppError(502, 'stripe_error');
      return { url: s.url };
    },
  },
  'billing/openPortal': {
    schema: z.object({}),
    async run({ db, client, deps }) {
      const { customer } = stripeIds(db);
      if (!customer) throw new AppError(409, 'no_customer');
      const s = await client.createPortalSession(customer, deps.returnUrl);
      if (typeof s?.url !== 'string') throw new AppError(502, 'stripe_error');
      return { url: s.url };
    },
  },
  'billing/setSeats': {
    schema: z.object({ seats: seatsSchema }),
    async run({ db, client, events }, { seats }) {
      const { subscription } = stripeIds(db);
      if (!subscription) throw new AppError(409, 'no_subscription');
      assertSeatsCover(db, seats);
      const sub = await client.getSubscription(subscription);
      const item = sub?.items?.data?.[0];
      if (!item?.id) throw new AppError(502, 'stripe_error');
      await client.setItemQuantity(item.id, seats);
      // The webhook confirms it too; the seats show at once.
      db.prepare('UPDATE account SET purchased_seats=? WHERE stripe_subscription_id=?').run(seats, subscription);
      events.push({ model: 'account', op: 'upsert', row: accountRow(db) });
      return { seats };
    },
  },
  'billing/listInvoices': {
    schema: z.object({}),
    async run({ db, client }) {
      const { customer } = stripeIds(db);
      if (!customer) return { invoices: [] };
      const r = await client.listInvoices(customer, INVOICE_LIMIT);
      const invoices = (Array.isArray(r?.data) ? r.data : []).slice(0, INVOICE_LIMIT).map((i: any) => ({
        number: typeof i.number === 'string' ? i.number : null,
        date: typeof i.created === 'number' ? i.created * 1000 : null,
        amountCents: typeof i.total === 'number' ? i.total : typeof i.amount_due === 'number' ? i.amount_due : 0,
        currency: typeof i.currency === 'string' ? i.currency : '',
        status: typeof i.status === 'string' ? i.status : null,
        hostedUrl: typeof i.hosted_invoice_url === 'string' && i.hosted_invoice_url.startsWith('https://') ? i.hosted_invoice_url : null,
      }));
      return { invoices };
    },
  },
};

export async function runBillingCommand(db: Db, user: User | Actor, name: string, payload: unknown, deps: BillingDeps): Promise<{ payload: unknown; actionId: string; events: ChangeEvent[] }> {
  const cmd = Object.hasOwn(billingCommands, name) ? billingCommands[name] : undefined;
  if (!cmd) throw new AppError(404, 'unknown_command');
  const actor = toActor(user);
  assertTokenScope(actor, name);
  const parsed = cmd.schema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues });
  assertCan(db, actor, 'account.manage');
  if (billingModeOf(db) !== 'stripe') throw new AppError(409, 'billing_off');
  if (!deps.client) throw new AppError(503, 'stripe_not_configured');
  const events: ChangeEvent[] = [];
  const out = await cmd.run({ db, actor, client: deps.client, deps, events }, parsed.data);
  return { payload: out, actionId: nextActionId(), events };
}
