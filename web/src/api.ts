import { store } from './store';
import type { ActivityItem } from '../../shared/activity';
import type { Card, CardHistory, Deck, OrgRole, Reaction, Resolvable, ResolvableEntry, TimeSegment } from '../../shared/types';

/** An active invite link as admins see it; the token itself is only known when it is created. */
export interface InviteInfo { tokenHash: string; role: Exclude<OrgRole, 'owner'>; projectIds: string[]; expiresAt: number; createdBy: string }
import { showToast } from './toast';
import { noteCommand } from './onboarding';
import type { McpConnection } from './views/settings/Mcp';
import type { UserReportSettings } from './views/settings/UserReports';
import type { Invoice } from './views/settings/Billing';
import type { EmailStatus, NotificationPref } from './views/settings/Email';
import type { IntegrationSettings } from './views/settings/Discord';

export const CONFLICT_TEXT = 'Someone changed this task while you were editing. Your view now shows their version.';

/** `GET /api/tailscale`. */
export interface TailscaleInfo {
  enabled: boolean; login: string | null; displayName: string | null; linkedUserId: string | null; sessionVia: 'tailscale' | null;
}
/** A person Tailscale knows who asked to join; shown under "Waiting to join". */
export interface JoinRequest { login: string; displayName: string; firstSeen: number; lastSeen: number }

export interface ExitOption { id: string; label: string; followUp: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data?: unknown) {
    super(code);
  }
}

/** Plain-language text for codes a person can act on; anything else shows the raw code. */
const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  space_not_empty: 'That area still has lists. Move or delete them first.',
  bad_credentials: 'Wrong email or password.',
  already_member: 'That person already has an account: they can link Tailscale themselves under My account.',
  disabled_member: "That person's account is disabled. Enable it on the Members page first.",
  not_found: 'That request is gone. The list was refreshed.',
  not_tailscale: "This device isn't signed in through Tailscale.",
  already_linked: 'That Tailscale account is already linked to someone else.',
  already_setup: 'This workspace is already set up. Log in instead.',
  setup_token: 'This server is set up from the Jatify Launcher (it needs the admin token), not from this page.',
  invalid_input: 'Please fill in every field.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  invite_invalid: 'This invite link is not valid.',
  invite_expired: 'This invite link has expired.',
  email_taken: 'That email is already in use.',
  network: "Can't reach the server.",
  file_too_large: 'That file is larger than the upload limit.',
  hierarchy_cycle: "That would put a task under its own subtask.",
  invalid_hierarchy: "Those tasks can't be linked (lore, deleted tasks and tasks from other projects can't be main tasks or subtasks).",
  dependency_cycle: 'That would make the tasks lock each other.',
  invalid_dependency: 'Only live tasks of the same project can lock each other.',
  feature_disabled: 'That feature is switched off in the workspace settings.',
  bad_cover_url: "Couldn't load an image from that link. Check it points straight at a PNG, JPEG, GIF or WebP.",
  too_large: 'That image is too large.',
  bad_type: 'Covers must be a PNG, JPEG, GIF or WebP image.',
  bad_cover: "That cover can't be used in this project.",
  guardian_only: 'Only reviewers can do this.',
  invalid_payload: "Some of those values aren't allowed.",
  hand_full: 'Your active tasks are full',
  hand_synced: 'This task is synced from its list',
  too_many_cards: 'That is more tasks than one import or copy can take.',
  too_many_decks: 'That is more lists than one import can take.',
  too_many_tags: 'That would give the project more than 100 tags.',
  invalid_json: "That file isn't valid JSON.",
  import_running: 'Another import or project copy is running. Try again when it has finished.',
  project_archived: 'That project is archived. Restore it first.',
  not_enough_disk: 'There is not enough free disk space for the copied attachments.',
  hacknplan_auth: 'HacknPlan did not accept that API key.',
  hacknplan_not_found: "HacknPlan has no project with that number for this key.",
  hacknplan_unavailable: "Couldn't reach HacknPlan. Try again later.",
  plan_limit: "That's over your plan's limit. Upgrade in the workspace menu (click the workspace name), under Plan & billing.",
  plan_feature: 'That feature is part of the Pro plan. Existing values stay, but new ones need Pro.',
  already_subscribed: 'This workspace already has a subscription. Change the plan or seats under Manage payment.',
  billing_off: 'This workspace is self-hosted and has no billing.',
  no_customer: 'There is no payment account yet. Pick a plan first.',
  no_subscription: 'There is no subscription yet. Pick a plan first.',
  price_missing: "That plan can't be bought with this billing period here.",
  stripe_error: "The payment provider didn't accept that. Try again later.",
  stripe_unavailable: "Couldn't reach the payment provider. Try again later.",
  stripe_not_configured: 'Payments are not set up on this server.',
  not_configured: 'Fill in and save the settings this needs first.',
  discord_unavailable: "Couldn't reach Discord. Try again later.",
  discord_error: 'Discord refused the request. Check the application id, guild id and bot token.',
  workspace_disabled: 'This workspace is disabled. Only its owner can sign in and reactivate it.',
  url_taken: 'Another project already uses that URL name.',
  invalid_url_name: 'Use 3 to 40 lowercase letters, digits and single hyphens for the URL name.',
  upvoting_off: 'Upvoting is switched off for this project.',
  unconfirmed: 'Confirm your email address first.',
  // Wiki
  duplicate_key: 'That key is already used in this project.',
  not_lore: 'Only lore can be a wiki entry.',
  other_campaign: 'Wiki links and pages stay within one project.',
  cycle: 'That would file the lore under itself.',
  type_not_allowed: "That link doesn't fit these lore types.",
  unknown_kind: 'That link kind no longer exists.',
  unknown_type: 'That lore type no longer exists in this project.',
  invalid_props: "Some of those link values don't fit.",
  limit: 'That is over the wiki limit for this project.',
  type_in_use: 'That type is still in use.',
  field_removed: 'Fields are hidden, never removed.',
  reserved_key: 'That key is reserved.',
  hacknplan_too_large: 'That HacknPlan project holds more data than one import can take (20 MB).',
};
export const messageFor = (code: string) => MESSAGES[code] ?? `Something went wrong (${code}).`;

/** A request body that is already JSON text (a large file sent without parsing and serialising it again). */
export class JsonText { constructor(public text: string) {} }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : body instanceof JsonText ? body.text : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json?.data);
  return json as T;
}

/** Unauthenticated / auth endpoints. Callers show their own errors (inline on forms). */
export const api = {
  status: () => request<{ setup: boolean; disabled?: boolean; workspace?: unknown; suggestions?: unknown }>('GET', '/api/status'),
  setup: (b: { workspaceName: string; name: string; email: string; password: string }) => request('POST', '/api/setup', b),
  login: (b: { email: string; password: string }) => request<{ workspaceDisabled?: boolean }>('POST', '/api/login', b),
  /** Danger Zone: why the owner is leaving (server/commands/dangerZone.ts EXIT_OPTIONS). */
  exitOptions: () => request<{ options: ExitOption[] }>('GET', '/api/exit-options'),
  /** Danger Zone, from the disabled screen: errors are shown inline there, so this skips dispatch's toast. */
  reactivate: () => request<{ payload: { reactivated: boolean; subscriptionResumed: boolean } }>('POST', '/dispatch/dangerZone/reactivate', {}),
  logout: () => request('POST', '/api/logout', {}),
  invite: (token: string) => request<{ role: string }>('GET', `/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, b: { name: string; email: string; password: string }) =>
    request('POST', `/api/invites/${encodeURIComponent(token)}/accept`, b),
  /** One card by account seq, deleted ones included (the snapshot leaves those out). */
  card: (seq: number) =>
    request<{ card: Card; deck: Deck | null; resolvables: Resolvable[]; entries: ResolvableEntry[]; reactions: Reaction[] }>('GET', `/api/cards/${seq}`),
  invites: () => request<InviteInfo[]>('GET', '/api/invites'),
  /** This connection's Tailscale person and how the session was made (signed-in people). */
  tailscale: () => request<TailscaleInfo>('GET', '/api/tailscale'),
  /** Signs this person in by Tailscale from now on; asks for the current password. Errors are shown inline by the caller. */
  linkTailscale: (password: string) => request<{ ok: true; login: string }>('POST', '/api/tailscale/link', { password }),
  /** People Tailscale knows who asked to join (needs the right to manage people). */
  teamRequests: () => request<{ requests: JoinRequest[] }>('GET', '/api/team-requests'),
  closedThreads: (cardId: string) =>
    request<{ threads: { resolvable: Resolvable; entries: ResolvableEntry[]; reactions: Reaction[] }[] }>('GET', `/api/cards/${encodeURIComponent(cardId)}/threads?closed=1`),
  activity: (q: { deckId?: string; projectId?: string; milestoneId?: string; sprintId?: string; before?: string | null; filters?: string[] }) => {
    const p = new URLSearchParams();
    if (q.deckId) p.set('deckId', q.deckId);
    if (q.projectId) p.set('projectId', q.projectId);
    if (q.milestoneId) p.set('milestoneId', q.milestoneId);
    if (q.sprintId) p.set('sprintId', q.sprintId);
    if (q.before) p.set('before', q.before);
    if (q.filters?.length) p.set('filters', q.filters.join(','));
    return request<{ items: ActivityItem[]; next: string | null }>('GET', `/api/activity?${p}`);
  },
  /** Home's "Recently worked on": the cards I changed or commented on lately, newest first (server/home.ts). */
  homeRecent: () => request<{ items: { cardId: string; at: number }[] }>('GET', '/api/me/recent'),
  /** All-time tracked time of a card and its newest 200 segments. */
  cardTime: (cardId: string) => request<{ totalMs: number; segments: TimeSegment[] }>('GET', `/api/cards/${encodeURIComponent(cardId)}/time`),
  history: (cardId: string) => request<CardHistory[]>('GET', `/api/cards/${encodeURIComponent(cardId)}/history`),
  /** MCP tool calls today and connections (admins: everyone's, others: their own). */
  mcpUsage: () => request<{ toolCallsToday: number; connections: McpConnection[] }>('GET', '/api/mcp/usage'),
  /** The workspace's last invoices (Billing tab; owners and admins, billing mode 'stripe'). No toast on failure. */
  billingInvoices: () => request<{ payload: { invoices: Invoice[] } }>('POST', '/dispatch/billing/listInvoices', {}).then((r) => r.payload),
  /** User report app and tokens (admins); never the access key or a token itself. */
  userReports: () => request<UserReportSettings>('GET', '/api/user-reports'),
  /** Email transport and the newest 200 outbox rows (admins). */
  emailStatus: () => request<EmailStatus>('GET', '/api/email/status'),
  /** My notification email preference. */
  emailPrefs: () => request<{ notifications: NotificationPref }>('GET', '/api/email/prefs'),
  /** A wiki entry's aliases, replaced as a whole. Errors are shown inline by the aliases editor (no toast). */
  setAliases: (cardId: string, aliases: string[]) =>
    request<{ payload: { aliases: string[] } }>('POST', '/dispatch/wiki/setAliases', { cardId, aliases }).then((r) => r.payload),
  /** Discord and Slack settings (admins); secrets only as set / not set. */
  integrations: () => request<IntegrationSettings>('GET', '/api/integrations'),
};

/**
 * Runs a command. The resulting change events arrive over the live socket.
 * Errors are shown as a toast and rethrown so callers can keep a dialog open.
 */
export async function dispatch<T = unknown>(ns: string, action: string, payload: object | JsonText): Promise<T> {
  try {
    const r = await request<{ payload: T; actionId: string }>('POST', `/dispatch/${ns}/${action}`, payload);
    noteCommand(ns, action, payload);
    return r.payload;
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(0, 'network');
    if (err.status === 409 && err.code === 'conflict' && err.data && typeof err.data === 'object') {
      store.apply([{ model: 'card', op: 'upsert', row: err.data }]);
      showToast(CONFLICT_TEXT, 'info', 9000);
    } else if (err.status === 401) {
      store.reset('unauthenticated');
    } else if (err.status === 423) {
      store.reset('disabled');
    } else if (err.code === 'stale_hand') {
      void store.load(); // the Hand changed under us: show the current one, no toast
    } else if (err.code === 'hand_full' || err.code === 'hand_synced') {
      showToast(MESSAGES[err.code]);
    } else {
      showToast(MESSAGES[err.code] ? `${MESSAGES[err.code]} (${err.code})` : messageFor(err.code));
    }
    throw err;
  }
}

/**
 * Uploads one file as the raw request body (streamed by the browser, never read into memory here).
 * The change events arrive over the live socket. Errors are shown as a toast and rethrown.
 */
export async function uploadFile(cardId: string, file: File): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/files?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    showToast(`Couldn't upload ${file.name}: ${MESSAGES.network}`);
    throw new ApiError(0, 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, json?.error ?? `http_${res.status}`);
    if (res.status === 401) store.reset('unauthenticated');
    else showToast(`Couldn't upload ${file.name}. ${MESSAGES[err.code] ?? messageFor(err.code)}`);
    throw err;
  }
  return json as { id: string };
}
