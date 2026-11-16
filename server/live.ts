import type { Db } from './db';
import { toCamel } from './db';
import type { ChangeEvent } from './dispatch';
import { can } from './permissions';
import { canSeeCard, cardProjectId } from './access';
import { now } from './auth';

export const MAX_SOCKETS = 200;

export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type Route =
  | { to: 'all' }
  | { to: 'user'; userId: string }
  /** Account admins, plus optionally one user. */
  | { to: 'admins'; alsoUser?: string }
  | { to: 'project'; projectId: string; alsoUser?: string }
  | { to: 'projects'; projectIds: string[] }
  | { to: 'card'; card: { deckId: string | null; creatorId: string }; projectId: string | null }
  | null;

export class LiveHub {
  private sockets = new Map<LiveSocket, { userId: string; session: string | null }>();
  constructor(private db: Db) {}

  get size(): number {
    return this.sockets.size;
  }

  add(socket: LiveSocket, user: { id: string }, sessionHash: string | null = null): boolean {
    if (this.sockets.size >= MAX_SOCKETS) {
      socket.close(1013, 'too_many_connections');
      return false;
    }
    this.sockets.set(socket, { userId: user.id, session: sessionHash });
    return true;
  }

  remove(socket: LiveSocket): void {
    this.sockets.delete(socket);
  }

  /** Close every socket that belongs to this session (logout). */
  closeSession(sessionHash: string): void {
    for (const [s, v] of [...this.sockets]) {
      if (v.session === sessionHash) {
        this.sockets.delete(s);
        s.close(4401, 'logged_out');
      }
    }
  }

  private sessionAlive(hash: string | null): boolean {
    if (hash === null) return true;
    const r = this.db.prepare('SELECT expires_at e FROM sessions WHERE token_hash=?').get(hash) as { e: number } | undefined;
    return !!r && r.e > now();
  }

  /** Close sockets whose session is gone or expired, or whose user is disabled. */
  sweep(): void {
    for (const [socket, v] of [...this.sockets]) this.checkSocket(socket, v);
  }

  private checkSocket(socket: LiveSocket, v: { userId: string; session: string | null }): boolean {
    const u = this.db.prepare('SELECT disabled d FROM users WHERE id=?').get(v.userId) as { d: number } | undefined;
    if (!u || u.d) {
      this.sockets.delete(socket);
      socket.close(4001, 'disabled');
      return false;
    }
    if (!this.sessionAlive(v.session)) {
      this.sockets.delete(socket);
      socket.close(4401, 'session_ended');
      return false;
    }
    return true;
  }

  private route(ev: ChangeEvent): Route {
    const row = ev.row as any;
    const { db } = this;
    switch (ev.model) {
      case 'account': case 'user': case 'accountRole':
        return { to: 'all' };
      case 'preset':
        return { to: 'all' };
      case 'apiToken':
        // Token rows (never hashes) go to admins, and a personal token's row to its owner too (as in the snapshot).
        return row.kind === 'user' ? { to: 'admins', alsoUser: row.userId } : { to: 'admins' };
      case 'projectPref': case 'userCardTag': case 'resolvableNotification': case 'cardSubscription': case 'deckSubscription': case 'bookmark': case 'donePile': case 'savedSearch': case 'onboardingStep':
        return { to: 'user', userId: row.userId };
      case 'project':
        // remove and access carry only {id} and go to everyone; access tells clients to reload.
        return ev.op === 'upsert' ? { to: 'project', projectId: row.id } : { to: 'all' };
      case 'projectAccess':
        return { to: 'project', projectId: row.projectId, alsoUser: row.userId };
      case 'milestone': case 'milestoneZone': {
        // Remove events carry isGlobal/projectIds (milestone) or milestoneId (zone), so they route after the row is gone.
        let m = row;
        if (ev.model === 'milestoneZone') {
          const mid = row.milestoneId as string;
          const g = db.prepare('SELECT is_global g FROM milestones WHERE id=?').get(mid) as { g: number } | undefined;
          if (!g) return null;
          m = { isGlobal: !!g.g, projectIds: (db.prepare('SELECT project_id p FROM milestone_projects WHERE milestone_id=?').all(mid) as { p: string }[]).map((r) => r.p) };
        }
        return m.isGlobal ? { to: 'all' } : { to: 'projects', projectIds: m.projectIds as string[] };
      }
      case 'sprintConfig': case 'sprint': {
        // Remove events for configs carry isGlobal/projectIds; sprint rows route by their config.
        let c = row;
        if (ev.model === 'sprint') {
          const g = db.prepare('SELECT is_global g FROM sprint_configs WHERE id=?').get(row.configId) as { g: number } | undefined;
          if (!g) return null;
          c = { isGlobal: !!g.g, projectIds: (db.prepare('SELECT project_id p FROM sprint_config_projects WHERE config_id=?').all(row.configId) as { p: string }[]).map((r) => r.p) };
        }
        return c.isGlobal ? { to: 'all' } : { to: 'projects', projectIds: c.projectIds as string[] };
      }
      case 'sprintProgress':
        return { to: 'project', projectId: row.projectId };
      case 'milestoneProgress':
        return { to: 'project', projectId: row.projectId };
      case 'journey':
        return { to: 'project', projectId: row.projectId };
      case 'entryLink': {
        // As in the snapshot: only a link whose two ends are live cards of the link's project is shown. Seeing a
        // project means seeing every card in its decks (canSeeCard), so its viewers are exactly those who see both ends.
        if (ev.op === 'upsert') {
          const live = db.prepare(`SELECT COUNT(*) n FROM cards c JOIN decks d ON d.id=c.deck_id
            WHERE c.id IN (?,?) AND c.visibility!='deleted' AND d.project_id=?`).get(row.fromCardId, row.toCardId, row.projectId) as { n: number };
          if (live.n < (row.fromCardId === row.toCardId ? 1 : 2)) return null;
        }
        return { to: 'project', projectId: row.projectId };
      }
      case 'entryType': case 'linkKind':
        // Wiki rows, removes included, carry their projectId.
        return { to: 'project', projectId: row.projectId };
      case 'visionBoard': case 'visionQuery': {
        // Routed by the host card; a deleted host card routes nowhere (the board is hidden until it is restored).
        const c = db.prepare('SELECT * FROM cards WHERE id=?').get(row.cardId) as Record<string, unknown> | undefined;
        if (!c || c.visibility === 'deleted') return null;
        const card = toCamel<any>(c);
        return { to: 'card', card, projectId: card.deckId ? cardProjectId(db, row.cardId) : null };
      }
      case 'deckGuardian':
        return { to: 'project', projectId: row.projectId };
      case 'deck':
        return { to: 'project', projectId: row.projectId };
      case 'card': {
        if (ev.op === 'remove') return { to: 'project', projectId: row.projectId };
        return { to: 'card', card: row, projectId: row.deckId ? cardProjectId(db, row.id) : null };
      }
      case 'cardDep': {
        // Viewers of the locked card's project, plus the locking card's project when it differs.
        const ids = [row.lockedCardId, row.lockingCardId].map((c: string) => cardProjectId(db, c)).filter((p): p is string => !!p);
        return ids.length ? { to: 'projects', projectIds: [...new Set(ids)] } : null;
      }
      case 'resolvable': case 'resolvableEntry': case 'reaction': case 'handCard': case 'file': case 'timeSegment': {
        let cardId: string | undefined = row.cardId;
        if (ev.model === 'resolvableEntry' || ev.model === 'reaction') {
          // Reaction events carry cardId/resolvableId themselves, so removals still route after the row is gone.
          cardId = row.cardId ?? (db.prepare('SELECT card_id c FROM resolvables WHERE id=?').get(
            ev.model === 'reaction'
              ? (row.resolvableId ?? (db.prepare('SELECT resolvable_id r FROM resolvable_entries WHERE id=?').get(row.entryId) as { r: string } | undefined)?.r)
              : row.resolvableId) as { c: string } | undefined)?.c;
        }
        if (!cardId) return null;
        const c = db.prepare('SELECT * FROM cards WHERE id=?').get(cardId) as Record<string, unknown> | undefined;
        if (!c) return null;
        const card = toCamel<any>(c);
        return { to: 'card', card, projectId: card.deckId ? cardProjectId(db, cardId) : null };
      }
    }
    return null;
  }

  /** Called with every published batch, sockets or not (the vision-board rooms re-check access). */
  onPublish: ((events: ChangeEvent[]) => void) | null = null;

  publish(actionId: string, events: ChangeEvent[]): void {
    if (this.onPublish && events.length) {
      try {
        this.onPublish(events);
      } catch (e) {
        console.error('publish listener failed', e);
      }
    }
    if (this.sockets.size === 0 || events.length === 0) return;
    const routed = events.map((e) => ({ e, r: this.route(e) })).filter((x) => x.r);
    const memo = new Map<string, boolean>();
    for (const [socket, v] of [...this.sockets]) {
      const userId = v.userId;
      if (!this.checkSocket(socket, v)) continue;
      const user = { id: userId };
      const view = (pid: string) => {
        const k = `${userId}|${pid}`;
        let v = memo.get(k);
        if (v === undefined) memo.set(k, (v = can(this.db, user, 'project.view', pid)));
        return v;
      };
      const mine = routed.filter(({ r }) => {
        switch (r!.to) {
          case 'all': return true;
          case 'user': return (r as any).userId === userId;
          case 'admins': return (r as any).alsoUser === userId || can(this.db, user, 'account.manage');
          case 'project': return view((r as any).projectId) || (r as any).alsoUser === userId;
          case 'projects': return (r as any).projectIds.some((p: string) => view(p));
          case 'card': {
            const x = r as Extract<NonNullable<Route>, { to: 'card' }>;
            return x.card.deckId
              ? !!x.projectId && view(x.projectId)
              : canSeeCard(this.db, user, x.card, null);
          }
        }
      }).map((x) => x.e);
      if (mine.length === 0) continue;
      try {
        socket.send(JSON.stringify({ type: 'events', actionId, events: mine }));
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
