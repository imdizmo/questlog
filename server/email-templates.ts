/**
 * Our email copy: each template returns a subject, a plain-text body and a simple HTML body (inline styles only, no
 * images, no scripts). Every value that comes from people (names, card titles) is escaped in the HTML.
 */
export interface RenderedEmail { subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(heading: string, body: string, footer: string): string {
  return '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ee;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#22201c">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px 28px">'
    + `<h1 style="font-size:18px;margin:0 0 16px">${heading}</h1>${body}</div>`
    + `<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#77726a">${footer}</p></body></html>`;
}
const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:#b4472b">${esc(label)}</a>`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface DigestThread { cardTitle: string; cardUrl: string; unseen: number; authors: string[]; context: string }
const CONTEXT: Record<string, string> = { comment: 'comment', review: 'review', block: 'blocker' };

/** Unseen conversations since the last email ('daily' at 08:00, or 'instant' within minutes). */
export function digestEmail(p: {
  workspace: string; name: string; threads: DigestThread[]; more: number; inboxUrl: string; settingsUrl: string; unsubscribeUrl: string; instant: boolean;
}): RenderedEmail {
  const n = p.threads.length + p.more;
  const subject = p.instant
    ? `${p.workspace}: ${plural(n, 'conversation has', 'conversations have')} news for you`
    : `${p.workspace}: your daily round-up (${plural(n, 'conversation', 'conversations')})`;
  const intro = p.instant
    ? `Hi ${p.name}, there is something new in conversations you follow.`
    : `Good morning ${p.name}! Here is what happened in conversations you follow since your last round-up.`;
  const line = (t: DigestThread) => `${plural(t.unseen, 'new message', 'new messages')}${t.authors.length ? ` from ${t.authors.join(', ')}` : ''} (${CONTEXT[t.context] ?? t.context})`;
  const moreText = p.more > 0 ? `\n…and ${plural(p.more, 'more conversation', 'more conversations')} in your messages.\n` : '';
  const text = `${intro}\n\n${p.threads.map((t) => `* ${t.cardTitle}\n  ${line(t)}\n  ${t.cardUrl}`).join('\n\n')}\n${moreText}\n`
    + `Open your messages: ${p.inboxUrl}\n\n--\nYou get these emails because of your settings in ${p.workspace}. Change them: ${p.settingsUrl}\n`
    + `Stop notification emails: ${p.unsubscribeUrl}\n`;
  const items = p.threads.map((t) => `<li style="margin:0 0 12px">${link(t.cardUrl, t.cardTitle)}<br><span style="color:#77726a;font-size:14px">${esc(line(t))}</span></li>`).join('');
  const html = layout(esc(p.instant ? 'New in your conversations' : 'Your daily round-up'),
    `<p>${esc(intro)}</p><ul style="padding-left:20px">${items}</ul>`
    + (p.more > 0 ? `<p>…and ${esc(plural(p.more, 'more conversation', 'more conversations'))} in your messages.</p>` : '')
    + `<p>${link(p.inboxUrl, 'Open your messages')}</p>`,
    `You get these emails because of your settings in ${esc(p.workspace)}. ${link(p.settingsUrl, 'Change them')} or ${link(p.unsubscribeUrl, 'stop notification emails')}.`);
  return { subject, text, html };
}

/**
 * To someone who sent in a report and left an address: which of their reports were resolved, by card code. The
 * address is unverified, so the email holds only fixed text, the report app's name (set by admins) and card codes;
 * never the report's text or the card's title.
 */
export function reportDoneEmail(p: { appName: string; codes: string[]; unsubscribeUrl: string }): RenderedEmail {
  const one = p.codes.length === 1;
  const list = p.codes.join(', ');
  const subject = one ? `${p.appName}: your report ${p.codes[0]} was resolved` : `${p.appName}: ${p.codes.length} of your reports were resolved`;
  const intro = one
    ? `Thanks for sending a report about ${p.appName}. Your report ${list} was resolved.`
    : `Thanks for sending reports about ${p.appName}. Your reports ${list} were resolved.`;
  const footer = 'You get this email because this address was given with a report. If that wasn\'t you, or you\'d rather not hear back, unsubscribe';
  const text = `${intro}\n\nThanks for helping make it better!\n\n--\n${footer}: ${p.unsubscribeUrl}\n`;
  const html = layout(esc(one ? 'Your report was resolved' : 'Your reports were resolved'),
    `<p>${esc(intro)}</p><p>Thanks for helping make it better!</p>`,
    `${esc(footer)}: ${link(p.unsubscribeUrl, 'stop these emails')}.`);
  return { subject, text, html };
}

/** An invite link sent by an admin. */
export function inviteEmail(p: { workspace: string; inviter: string; role: string; url: string; days: number }): RenderedEmail {
  const subject = `${p.inviter} invited you to ${p.workspace}`;
  const intro = `${p.inviter} would like you to join ${p.workspace} as ${p.role === 'admin' ? 'an admin' : `a ${p.role}`}.`;
  const text = `Hi!\n\n${intro}\n\nJoin here: ${p.url}\n\nThe link works for ${p.days} days. If you weren't expecting this, you can ignore this email.\n`;
  const html = layout(esc(`Join ${p.workspace}`),
    `<p>Hi!</p><p>${esc(intro)}</p><p>${link(p.url, 'Accept the invite')}</p>`
    + `<p style="font-size:14px;color:#77726a">Or paste this address into your browser: ${esc(p.url)}</p>`,
    `The link works for ${p.days} days. If you weren't expecting this, you can ignore this email.`);
  return { subject, text, html };
}

/**
 * The link that finishes a sign-up on an Open Deck page. The address is unverified, so the email holds fixed text and
 * the link only: no name or anything else the visitor typed.
 */
export function guestConfirmEmail(p: { url: string; hours: number }): RenderedEmail {
  const subject = 'Finish signing up';
  const intro = 'Hi! Someone (hopefully you) signed up with this address to upvote tasks and follow a public project. Use the link to finish.';
  const tail = `The link works for ${p.hours} hours. If you didn't sign up, ignore this email: no account is made without the link.`;
  const text = `${intro}\n\nFinish signing up: ${p.url}\n\n${tail}\n`;
  const html = layout(esc(subject), `<p>${esc(intro)}</p><p>${link(p.url, 'Finish signing up')}</p>`, esc(tail));
  return { subject, text, html };
}

/** Sent instead of a confirmation when the address already has an account: nothing changes. Fixed text only. */
export function signUpNoticeEmail(p: { signInUrl: string }): RenderedEmail {
  const subject = 'Someone tried to sign up with your address';
  const intro = 'Someone tried to make a new account with this email address on a public project page. You already have an account, so nothing was changed.';
  const tail = "If it was you, sign in with your existing password. If it wasn't, you can ignore this email.";
  const text = `${intro}\n\n${tail}\n\nSign in: ${p.signInUrl}\n`;
  const html = layout(esc(subject), `<p>${esc(intro)}</p><p>${esc(tail)}</p><p>${link(p.signInUrl, 'Sign in')}</p>`, 'This is an automatic security notice.');
  return { subject, text, html };
}

export interface UpdateCard { title: string; url: string }

/** What's new in a public project since a subscriber's last update email: new cards and finished ones. */
export function openDeckUpdateEmail(p: {
  project: string; name: string; cadence: 'daily' | 'weekly'; added: UpdateCard[]; done: UpdateCard[]; more: number; projectUrl: string; unsubscribeUrl: string;
}): RenderedEmail {
  const period = p.cadence === 'daily' ? 'today' : 'this week';
  const subject = `${p.project}: what's new ${period}`;
  const intro = `Hi ${p.name}, here is what changed in ${p.project} since our last email.`;
  const section = (title: string, cards: UpdateCard[]) => (cards.length ? `${title}\n${cards.map((c) => `* ${c.title}\n  ${c.url}`).join('\n')}\n\n` : '');
  const moreText = p.more > 0 ? `…and ${plural(p.more, 'more task', 'more tasks')} on the page.\n\n` : '';
  const footer = `You get this email because you follow ${p.project}`;
  const text = `${intro}\n\n${section('New tasks', p.added)}${section('Done', p.done)}${moreText}See everything: ${p.projectUrl}\n\n--\n${footer}. Unsubscribe: ${p.unsubscribeUrl}\n`;
  const list = (title: string, cards: UpdateCard[]) => (cards.length
    ? `<h2 style="font-size:15px;margin:16px 0 8px">${esc(title)}</h2><ul style="padding-left:20px">${cards.map((c) => `<li style="margin:0 0 8px">${link(c.url, c.title)}</li>`).join('')}</ul>` : '');
  const html = layout(esc(`What's new in ${p.project}`),
    `<p>${esc(intro)}</p>${list('New tasks', p.added)}${list('Done', p.done)}`
    + (p.more > 0 ? `<p>…and ${esc(plural(p.more, 'more task', 'more tasks'))} on the page.</p>` : '')
    + `<p>${link(p.projectUrl, 'See everything')}</p>`,
    `${esc(footer)}. ${link(p.unsubscribeUrl, 'Unsubscribe')}.`);
  return { subject, text, html };
}

export interface DigestProject { name: string; url: string; upvotes: number; visits: number; subscribers: number; top: { title: string; upvotes: number; url: string }[] }

/** The weekly upvote digest for admins: per public project, last week's upvotes, visits, new followers and top cards. */
export function openDeckDigestEmail(p: { workspace: string; name: string; projects: DigestProject[]; unsubscribeUrl: string }): RenderedEmail {
  const subject = `${p.workspace}: your public lists last week`;
  const intro = `Good morning ${p.name}! Here is how your public projects did over the last seven days.`;
  const stats = (x: DigestProject) => `${plural(x.upvotes, 'upvote', 'upvotes')}, ${plural(x.visits, 'visit', 'visits')}, ${plural(x.subscribers, 'new follower', 'new followers')}`;
  const text = `${intro}\n\n${p.projects.map((x) => `${x.name} (${stats(x)})\n${x.url}\n${x.top.map((c) => `  ${c.upvotes} ▲ ${c.title}\n    ${c.url}`).join('\n')}`).join('\n\n')}\n\n`
    + `--\nYou get this digest as an admin of ${p.workspace}. Stop it: ${p.unsubscribeUrl}\n`;
  const html = layout(esc('Your public lists last week'),
    `<p>${esc(intro)}</p>${p.projects.map((x) => `<h2 style="font-size:15px;margin:16px 0 4px">${link(x.url, x.name)}</h2>`
      + `<p style="margin:0 0 8px;color:#77726a;font-size:14px">${esc(stats(x))}</p>`
      + (x.top.length ? `<ol style="padding-left:20px">${x.top.map((c) => `<li style="margin:0 0 6px">${link(c.url, c.title)} <span style="color:#77726a">(${esc(plural(c.upvotes, 'upvote', 'upvotes'))})</span></li>`).join('')}</ol>` : '')).join('')}`,
    `You get this digest as an admin of ${esc(p.workspace)}. ${link(p.unsubscribeUrl, 'Stop it')}.`);
  return { subject, text, html };
}
