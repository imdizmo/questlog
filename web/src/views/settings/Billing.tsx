import { useEffect, useId, useState } from 'react';
import { api, dispatch } from '../../api';
import { useStore } from '../../store';
import { effectivePlan, limitsFor, PLANS, seatsUsed, trialDaysLeft, type PlanStatus } from '../../../../shared/plans';
import type { Account } from '../../../../shared/types';

export interface Invoice { number: string | null; date: number | null; amountCents: number; currency: string; status: string | null; hostedUrl: string | null }

const STATUS_TEXT: Record<PlanStatus, string> = {
  trialing: 'Trial', active: 'Active', past_due: 'Payment overdue', canceled: 'Canceled',
};

const money = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() || 'EUR' }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`; }
};

/** Opens a Stripe page (Checkout or the customer portal); only https links are followed. */
const go = (url: unknown) => { if (typeof url === 'string' && url.startsWith('https://')) location.assign(url); };

/** The Billing tab: loads the invoices once (the page works without them), the rest comes from the account row. */
export function BillingSettings() {
  const account = useStore((s) => s.account);
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.accountRoles);
  const stripe = account?.billingMode === 'stripe';
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  useEffect(() => {
    if (!stripe) return;
    let live = true;
    api.billingInvoices().then((r) => { if (live) setInvoices(Array.isArray(r?.invoices) ? r.invoices : []); }, () => {});
    return () => { live = false; };
  }, [stripe]);
  const used = seatsUsed([...users.values()].map((u) => ({ role: roles.get(u.id) ?? '', disabled: u.disabled, kind: u.kind })));
  return <Billing account={account} seatsInUse={used} invoices={invoices ?? undefined} />;
}

/** Plan, trial, seats, upgrade, payment management and invoices. Tolerates any missing field (an older or trial row). */
export function Billing({ account, seatsInUse, invoices, now = Date.now() }: { account: Account | null; seatsInUse: number; invoices?: Invoice[]; now?: number }) {
  const id = useId();
  const [plan, setPlan] = useState<'plus' | 'pro'>('pro');
  const [interval, setBillEvery] = useState<'month' | 'year'>('month');
  const [seats, setSeats] = useState(String(Math.max(1, seatsInUse, account?.purchasedSeats ?? 0)));
  const [busy, setBusy] = useState(false);

  if (!account || account.billingMode !== 'stripe') {
    return <p data-testid="billing-off">This workspace is self-hosted. All features are on and there is no billing.</p>;
  }
  const current = effectivePlan(account, now);
  const limits = limitsFor(account, now);
  const status = (account.planStatus && STATUS_TEXT[account.planStatus]) || 'Active';
  const daysLeft = trialDaysLeft(account, now);
  const trial = account.planStatus === 'trialing';
  // A subscription on record changes through the portal (a second checkout would bill twice).
  const subscribed = !!account.hasSubscription;
  const hasCustomer = !!account.hasCustomer;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch { /* toast shown by dispatch */ } finally { setBusy(false); }
  };
  const upgrade = () => run(async () => {
    const n = Math.floor(Number(seats));
    const r = await dispatch<{ url: string }>('billing', 'startCheckout', { plan, interval, seats: Number.isFinite(n) && n >= 1 ? n : 1 });
    go(r?.url);
  });
  const portal = () => run(async () => { go((await dispatch<{ url: string }>('billing', 'openPortal', {}))?.url); });

  return (
    <div className="settings-stack" data-testid="billing">
      <section className="settings-group" aria-labelledby={`${id}-plan`}>
        <h3 className="sub" id={`${id}-plan`}>Your plan</h3>
        <p>
          <strong data-testid="billing-plan">{PLANS[current].label}</strong> <span className="badge">{status}</span>
        </p>
        {trial && (
          <p className="hint" data-testid="billing-trial">
            {daysLeft > 0
              ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} of the Pro trial left. Afterwards the workspace moves to Free unless you pick a plan.`
              : 'The Pro trial has ended. The workspace moves to Free unless you pick a plan.'}
          </p>
        )}
        {account.planStatus === 'past_due' && <p className="hint">The last payment did not go through. Update your payment method to keep the plan.</p>}
        <p data-testid="billing-seats">
          Seats in use: <strong>{seatsInUse}</strong>
          {limits.users !== null && <> of <strong>{limits.users}</strong></>}
          {!trial && (account.purchasedSeats ?? 0) > 0 && <> · purchased: <strong>{account.purchasedSeats}</strong></>}
        </p>
        <p className="hint">Observers and guests don't use a seat.</p>
        {account.billingCycleEnd ? <p className="hint">Current period ends {new Date(account.billingCycleEnd).toLocaleDateString()}.</p> : null}
      </section>

      {subscribed ? (
        <section className="settings-group" aria-labelledby={`${id}-up`}>
          <h3 className="sub" id={`${id}-up`}>Change plan or seats</h3>
          <p className="hint">Plan, seats and payment method are changed in the payment portal.</p>
          <div className="field-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void portal()}>Manage payment</button>
          </div>
        </section>
      ) : (
        <section className="settings-group" aria-labelledby={`${id}-up`}>
          <h3 className="sub" id={`${id}-up`}>Upgrade</h3>
          <div className="field-row">
            <label className="field">
              <span>Plan</span>
              <select value={plan} onChange={(e) => setPlan(e.target.value as 'plus' | 'pro')}>
                <option value="plus">Plus</option>
                <option value="pro">Pro</option>
              </select>
            </label>
            <label className="field">
              <span>Billed</span>
              <select value={interval} onChange={(e) => setBillEvery(e.target.value as 'month' | 'year')}>
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </label>
            <label className="field">
              <span>Seats</span>
              <input type="number" inputMode="numeric" min={Math.max(1, seatsInUse)} value={seats} onChange={(e) => setSeats(e.target.value)} />
            </label>
          </div>
          <p className="hint">Pro adds due dates, time tracking, dependencies, limited projects and reviewers.</p>
          <div className="field-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void upgrade()}>Upgrade</button>
            {hasCustomer && <button type="button" className="btn" disabled={busy} onClick={() => void portal()}>Manage payment</button>}
          </div>
        </section>
      )}

      <section className="settings-group" aria-labelledby={`${id}-inv`}>
        <h3 className="sub" id={`${id}-inv`}>Invoices</h3>
        {!invoices ? <p className="hint">Loading…</p> : invoices.length === 0 ? <p className="hint">No invoices yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {invoices.map((inv, i) => (
                  <tr key={inv.number ?? i}>
                    <th scope="row">{inv.hostedUrl ? <a href={inv.hostedUrl} target="_blank" rel="noopener noreferrer">{inv.number ?? 'Invoice'}</a> : (inv.number ?? 'Invoice')}</th>
                    <td>{inv.date ? new Date(inv.date).toLocaleDateString() : ''}</td>
                    <td>{money(inv.amountCents, inv.currency)}</td>
                    <td>{inv.status ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

