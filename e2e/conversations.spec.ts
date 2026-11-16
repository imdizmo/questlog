import { test, expect, type Page } from '@playwright/test';
import { mentionHandle } from '../shared/content';
import { cardCode } from '../shared/cards';
import { ensureWorkspace, newPerson, run, snapshot, unique, SHOTS } from './helpers';

async function inviteMember(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Workspace menu' }).click();
  await page.getByRole('menuitem', { name: 'Members' }).click();
  const members = page.getByRole('dialog', { name: 'Members' });
  await members.getByRole('button', { name: 'Invite people' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite people' });
  await invite.getByRole('radio', { name: /^Member/ }).check();
  await invite.getByRole('button', { name: 'Create link' }).click();
  const link = await invite.getByLabel('Invite link').inputValue();
  await invite.getByRole('button', { name: 'Done' }).click();
  await members.getByRole('button', { name: 'Close' }).first().click();
  return link;
}

async function join(page: Page, link: string, name: string) {
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(`${name.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await page.getByLabel('Password').fill('another good password');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page).toHaveURL(/\/decks$/);
}

test('conversations, inbox, watching and guardians between two people', async ({ page: a, browser }) => {
  await ensureWorkspace(a);
  const project = await run<{ id: string }>(a, 'projects', 'create', { name: unique('Harbor') });
  const deck = await run<{ id: string }>(a, 'decks', 'create', { title: 'Boats', projectId: project.id });
  const card = await run<{ id: string }>(a, 'cards', 'create', { deckId: deck.id, content: 'Rudder' });
  const snap = await snapshot(a);
  const seq = snap.cards.find((c: any) => c.id === card.id).seq as number;
  const deckSeq = snap.decks.find((d: any) => d.id === deck.id).seq as number;
  const cardPath = `/card/${cardCode(seq)}`;

  const link = await inviteMember(a);
  const b = await newPerson(browser);
  const bName = unique('Bea');
  await join(b, link, bName);
  const handle = mentionHandle(bName);

  // A opens a comment thread mentioning B.
  await a.goto(cardPath);
  await a.getByRole('button', { name: 'New' }).click();
  const composer = a.getByRole('dialog', { name: 'New comment thread' });
  await expect(composer.getByText('Mention people with @ to add them')).toBeVisible();
  await composer.getByLabel('Message').fill(`Please check the rudder @${handle}`);
  await composer.getByRole('button', { name: 'Send' }).click();
  await expect(a.getByTestId('thread')).toContainText('Please check the rudder');

  // B's inbox badge shows 1; B opens the thread from the inbox.
  const bell = b.getByRole('link', { name: /^Inbox/ });
  await expect(bell.getByTestId('inbox-badge')).toHaveText('1');
  await bell.click();
  await expect(b).toHaveURL(/\/inbox$/);
  const row = b.getByTestId('inbox-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Rudder');
  await expect(row).toContainText('Please check the rudder');
  await b.screenshot({ path: `${SHOTS}/phase3-inbox.png`, animations: 'disabled' });
  // The last-used side tab was Properties: opening from the inbox must still land on Conversations.
  await b.evaluate(() => localStorage.setItem('jt:cardSideTab', 'properties'));
  await row.getByRole('link', { name: 'Open' }).click();
  await expect(b.getByTestId('thread')).toContainText('Please check the rudder');
  // Opening it marks it seen.
  await expect(b.getByTestId('inbox-badge')).toHaveCount(0);

  // B replies and reacts; A sees both live.
  await b.getByLabel('Reply').fill('Looks fine to me');
  await b.getByRole('button', { name: 'Reply', exact: true }).click();
  await b.getByTestId('entry').filter({ hasText: 'Please check the rudder' }).getByRole('button', { name: '👍' }).click();
  await expect(a.getByTestId('thread')).toContainText('Looks fine to me', { timeout: 3000 });
  await expect(a.getByTestId('thread').getByRole('button', { name: /👍 1/ })).toBeVisible();
  await a.screenshot({ path: `${SHOTS}/phase3-thread.png`, animations: 'disabled' });

  // A edits their own message.
  const mine = a.getByTestId('entry').filter({ hasText: 'Please check the rudder' });
  await mine.getByRole('button', { name: 'Edit' }).click();
  await mine.getByLabel('Edit message').fill('Please check the rudder again');
  await mine.getByRole('button', { name: 'Save' }).click();
  await expect(mine).toContainText('(edited)');
  await expect(mine).toContainText('again');

  // B snoozes: the thread leaves B's inbox.
  await b.getByRole('button', { name: 'Snooze for 3 days' }).click();
  await b.goto('/inbox');
  await expect(b.getByTestId('inbox-row')).toHaveCount(0);
  await expect(b.getByTestId('inbox-badge')).toHaveCount(0);

  // A closes it; Show closed lists it.
  await a.getByRole('button', { name: 'Close this thread' }).click();
  await expect(a.getByTestId('thread')).toHaveCount(0);
  await a.getByRole('button', { name: 'Show closed' }).click();
  await expect(a.getByTestId('closed-thread')).toContainText('Please check the rudder again');
  await expect(a.getByTestId('closed-thread')).toContainText('Looks fine to me');

  // A watches the card.
  await a.getByRole('button', { name: 'More options' }).click();
  await a.getByRole('menuitem', { name: 'Watch task' }).click();
  await expect(a.getByLabel('Watching')).toBeVisible();
  await a.getByRole('button', { name: 'More options' }).click();
  await expect(a.getByRole('menuitem', { name: 'Stop watching' })).toBeVisible();
  await a.keyboard.press('Escape');

  // A turns on Guardians with only A; B can no longer mark the card as done.
  await b.goto(cardPath);
  await expect(b.getByRole('button', { name: 'Mark as done' })).toBeEnabled();
  await a.goto(`/decks/${deckSeq}`);
  await a.getByRole('button', { name: 'More list options' }).click();
  await a.getByRole('button', { name: 'Reviewers' }).click();
  const dlg = a.getByRole('dialog', { name: 'Reviewers' });
  await dlg.getByRole('switch', { name: 'Reviewers' }).check();
  await dlg.getByRole('checkbox', { name: 'Ada Owner' }).check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeHidden();
  await expect(b.getByRole('button', { name: 'Mark as done' })).toBeDisabled({ timeout: 3000 });
  await expect(b.getByRole('button', { name: 'Mark as done' })).toHaveAttribute('title', 'Only reviewers can do this');

  // Subscribing to a deck shows on the tile.
  await b.goto(`/decks/${deckSeq}`);
  await b.getByRole('button', { name: 'More list options' }).click();
  await b.getByRole('button', { name: 'Subscribe' }).click();
  await expect(b.getByRole('button', { name: 'Unsubscribe' })).toBeVisible();
  await b.goto('/decks');
  await expect(b.getByTestId('deck-tile').filter({ hasText: 'Boats' }).getByLabel('Subscribed')).toBeVisible();

  // `i` opens the inbox, but typing an i does not.
  await b.goto('/decks');
  await expect(b.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await b.keyboard.press('i');
  await expect(b).toHaveURL(/\/inbox$/);
  await b.goto(cardPath);
  await b.getByRole('button', { name: 'New' }).click();
  await b.getByLabel('Message').press('i');
  await b.waitForTimeout(300);
  await expect(b).not.toHaveURL(/inbox/);
  await b.context().close();
});
