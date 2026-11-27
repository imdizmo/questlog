import { useMemo, type ReactNode } from 'react';
import {
  smartAggregate, SMART_COLUMNS, SMART_COLUMN_LABEL, SMART_MODES, SMART_MODE_LABEL, SMART_ORDER_PROPS,
  type SmartColumn, type SmartMode, type SmartOrder,
} from '../../../shared/board';
import { derivedStatus, STATUS_LABEL, titleOf } from '../../../shared/cards';
import { groupCards, ORDER_LABELS, type OrderCtx } from '../../../shared/order';
import { compileSearch, savedSearchName, type SearchToken } from '../../../shared/search';
import type { Card, DerivedStatus, VisionQuery } from '../../../shared/types';
import { settingsOf, useStore } from '../store';
import { localToday, openByCard } from '../cards';
import { useSearchCtx, type SearchContexts } from '../search';
import { useShownTitle } from '../translate';

/** Table rows drawn per node; the rest are summarised, so a huge query keeps the board light. */
const TABLE_ROWS = 50;

/** A Smart Node's value with defaults filled in (readNode has already validated it). */
export interface SmartValue {
  queryId: string | null;
  mode: SmartMode;
  label: string;
  columns: SmartColumn[];
  order: SmartOrder | null;
  hideArchived: boolean;
  segments: boolean;
}

export function smartValue(v: Record<string, unknown>): SmartValue {
  return {
    queryId: typeof v.queryId === 'string' ? v.queryId : null,
    mode: SMART_MODES.includes(v.mode as SmartMode) ? (v.mode as SmartMode) : 'horBar',
    label: typeof v.label === 'string' ? v.label : '',
    columns: Array.isArray(v.columns) ? SMART_COLUMNS.filter((c) => (v.columns as unknown[]).includes(c)) : [],
    order: SMART_ORDER_PROPS.includes(v.order as SmartOrder) ? (v.order as SmartOrder) : null,
    hideArchived: v.hideArchived === true,
    segments: v.segments === true,
  };
}

/** Writes only what differs from the defaults, so the stored value stays small. */
export function smartToStored(v: SmartValue): Record<string, unknown> {
  return {
    queryId: v.queryId, mode: v.mode,
    ...(v.label ? { label: v.label } : {}),
    ...(v.columns.length ? { columns: v.columns } : {}),
    ...(v.order ? { order: v.order } : {}),
    ...(v.hideArchived ? { hideArchived: true } : {}),
    ...(v.segments ? { segments: true } : {}),
  };
}

/**
 * Cards the viewer can see that match the chips; the store only holds those. Deleted cards never match. With a
 * `projectId` (a Smart Node on Home, kept for a project) only that project's tasks.
 */
export function useMatchingCards(tokens: SearchToken[], forceOr: boolean, hideArchived = false, projectId: string | null = null): { cards: Card[]; ctx: SearchContexts } {
  const all = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const ctx = useSearchCtx();
  const cards = useMemo(() => {
    const test = compileSearch(tokens, forceOr, ctx.search);
    return [...all.values()]
      .filter((c) => c.visibility !== 'deleted' && !(hideArchived && c.visibility === 'archived'))
      .filter((c) => !projectId || (!!c.deckId && decks.get(c.deckId)?.projectId === projectId))
      .filter(test)
      .sort((a, b) => a.seq - b.seq);
  }, [all, decks, tokens, forceOr, hideArchived, projectId, ctx]);
  return { cards, ctx };
}

const EMPTY: SearchToken[] = [];

/** The node's label: its own, else the name of its query. */
export function smartLabel(v: SmartValue, query: VisionQuery | undefined, ctx: SearchContexts): string {
  return v.label || (query ? savedSearchName(query.query.tokens, ctx.suggest, query.query.forceOr) : 'Smart Node');
}

const STATUSES = Object.keys(STATUS_LABEL) as DerivedStatus[];

/** What a Smart Node shows. `labelSlot` replaces the label while it is being edited; it gets the name now shown. */
export function SmartBody({ value, labelSlot, onSetup }: { value: Record<string, unknown>; labelSlot?: (name: string) => ReactNode; onSetup?: () => void }) {
  const v = smartValue(value);
  const query = useStore((s) => (v.queryId ? s.visionQueries.get(v.queryId) : undefined));
  const { cards, ctx } = useMatchingCards(query?.query.tokens ?? EMPTY, query?.query.forceOr ?? false, v.mode === 'table' && v.hideArchived, query?.projectId ?? null);
  if (!v.queryId) {
    return (
      <div className="bnode-placeholder bsmart-empty">
        {labelSlot ? labelSlot(v.label || 'Smart Node') : <span>{v.label || 'Smart Node'}</span>}
        <span className="muted">No filter yet</span>
        {onSetup && <button type="button" className="btn btn-sm" data-node-action onClick={onSetup}>Set up filter</button>}
      </div>
    );
  }
  const name = smartLabel(v, query, ctx);
  if (!query) return <div className="bnode-placeholder bsmart-empty">{labelSlot ? labelSlot(name) : 'Filter not available'}</div>;
  return (
    <div className={`bsmart bsmart-${v.mode}`}>
      {labelSlot ? labelSlot(name) : <div className="bsmart-label" title={name}>{name}</div>}
      {v.mode === 'table' ? <SmartTable cards={cards} v={v} ctx={ctx} /> : <SmartChart cards={cards} v={v} ctx={ctx} />}
    </div>
  );
}

/** Each status's share of 0..100, in status order. */
function segments(parts: Array<{ s: string; n: number }>, total: number) {
  let at = 0;
  return parts.map((p) => { const w = (p.n / total) * 100; const out = { s: p.s, at, w }; at += w; return out; });
}

function SmartChart({ cards, v, ctx }: { cards: Card[]; v: SmartValue; ctx: SearchContexts }) {
  const agg = useMemo(
    () => smartAggregate(cards.filter((c) => !c.isDoc), (c) => ctx.search.status(c) === 'done', (c) => c.effort, (c) => ctx.search.status(c) ?? 'doc'),
    [cards, ctx],
  );
  const parts = STATUSES.flatMap((s) => (agg.byStatus[s]?.count ? [{ s, n: agg.byStatus[s].count }] : []));
  return (
    <div className="bsmart-body">
      {v.mode === 'horBar' && (
        <svg className="bsmart-hbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <rect className="bsmart-track" x="0" y="0" width="100" height="10" rx="3" />
          {v.segments
            ? segments(parts, agg.total).map((p) => <rect key={p.s} x={p.at} y="0" width={p.w} height="10" fill={`var(--st-${p.s})`} />)
            : <rect x="0" y="0" width={agg.pct} height="10" rx="3" fill="var(--st-done)" />}
        </svg>
      )}
      {v.mode === 'verBar' && (
        <svg className="bsmart-vbar" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">
          <rect className="bsmart-track" x="0" y="0" width="10" height="100" rx="3" />
          {v.segments
            ? segments(parts, agg.total).map((p) => <rect key={p.s} x="0" y={100 - p.at - p.w} width="10" height={p.w} fill={`var(--st-${p.s})`} />)
            : <rect x="0" y={100 - agg.pct} width="10" height={agg.pct} fill="var(--st-done)" />}
        </svg>
      )}
      {v.mode === 'donut' && (
        <div className="bsmart-donut">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="bsmart-ring" cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" />
            <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth="4" stroke="var(--st-done)" strokeDasharray={`${agg.pct} ${100 - agg.pct}`} transform="rotate(-90 18 18)" />
          </svg>
          <span className="bsmart-pct">{agg.pct}%</span>
        </div>
      )}
      {v.mode !== 'donut' && <span className={v.mode === 'number' ? 'bsmart-big' : 'bsmart-pct'}>{agg.pct}%</span>}
      <span className={v.mode === 'number' ? 'bsmart-sub' : 'sr-only'}>{agg.done} of {agg.total} done</span>
    </div>
  );
}

function SmartTable({ cards, v, ctx }: { cards: Card[]; v: SmartValue; ctx: SearchContexts }) {
  const shownTitle = useShownTitle();
  const s = useStore((x) => x);
  const settings = settingsOf(s);
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  const rows = useMemo(() => {
    if (!v.order) return cards;
    const today = localToday();
    const sprints = [...s.sprints.values()].sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr);
    const order: OrderCtx = {
      users: [...s.users.values()],
      milestones: [...s.milestones.values()].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.accountSeq - b.accountSeq),
      sprints, isDone: (c) => derivedStatus(c, open.get(c.id) ?? new Set()) === 'done',
      status: ctx.search.status, hasOpenNotification: () => false, timeTotal: () => 0,
      subCount: ctx.search.subCount, personalTags: ctx.search.personalTags,
      fallbackEffort: settings.fallbackEffort, priorityLabel: ctx.suggest.priorityLabel,
      currentSprintStart: (configId) => {
        const cur = sprints.find((x) => x.configId === configId && !x.isFinished && x.startDay <= today && today <= x.endDay);
        return cur ? new Date(`${cur.startDay}T00:00:00`).getTime() : null;
      },
    };
    return groupCards(cards, { prop: v.order, isReversed: false, mode: 'tableView', secondary: null }, order).flatMap((g) => g.cards);
  }, [cards, v.order, s.sprints, s.users, s.milestones, open, ctx, settings.fallbackEffort]);

  const cell = (c: Card, col: SmartColumn): string => {
    switch (col) {
      case 'priority': return c.priority ? ctx.suggest.priorityLabel(c.priority) : '';
      case 'effort': return c.effort === null ? '' : String(c.effort);
      case 'owner': return c.assigneeId ? s.users.get(c.assigneeId)?.name ?? '' : '';
      case 'run': return c.sprintId ? s.sprints.get(c.sprintId)?.label ?? '' : '';
      case 'milestone': return c.milestoneId ? s.milestones.get(c.milestoneId)?.name ?? '' : '';
      case 'checklist': return c.checkboxStats ? `${c.checkboxStats.checked}/${c.checkboxStats.total}` : '';
      case 'deck': return c.deckId ? s.decks.get(c.deckId)?.title ?? '' : '';
      case 'tags': return [...new Set([...c.masterTags, ...c.tags])].map((t) => `#${t}`).join(' ');
    }
  };
  const shown = rows.slice(0, TABLE_ROWS);
  return (
    <div className="bsmart-tablewrap">
      <table className="bsmart-table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            {v.columns.map((col) => <th key={col} scope="col">{SMART_COLUMN_LABEL[col]}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="bsmart-title">{shownTitle(c)}</th>
              {v.columns.map((col) => <td key={col}>{cell(c, col)}</td>)}
            </tr>
          ))}
          {rows.length > shown.length && <tr><td colSpan={v.columns.length + 1} className="muted">+{rows.length - shown.length} more</td></tr>}
          {rows.length === 0 && <tr><td colSpan={v.columns.length + 1} className="muted">No matching tasks</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export interface DisplayMenuProps {
  value: SmartValue;
  /** Deck features that gate sort options, as in the deck's own order menu. */
  features: { milestones: boolean; sprints: boolean; dueDate: boolean };
  onChange: (patch: Partial<SmartValue>) => void;
}

/** The Display popover: mode, then the options of that mode. Rendered inside the node toolbar. */
export function DisplayMenu({ value: v, features, onChange }: DisplayMenuProps) {
  const orders = SMART_ORDER_PROPS.filter((p) => (p === 'milestone' ? features.milestones : p === 'sprint' ? features.sprints : p === 'dueDate' ? features.dueDate : true));
  return (
    <>
      <div className="bsmart-menu-row" role="group" aria-label="Mode">
        {SMART_MODES.map((m) => (
          <button key={m} type="button" className="bswatch-btn" aria-pressed={v.mode === m} onClick={() => onChange({ mode: m })}>{SMART_MODE_LABEL[m]}</button>
        ))}
      </div>
      {(v.mode === 'horBar' || v.mode === 'verBar') && (
        <label className="bsmart-opt">
          <input type="checkbox" checked={v.segments} onChange={(e) => onChange({ segments: e.target.checked })} /> Show segments
        </label>
      )}
      {v.mode === 'table' && (
        <>
          <div className="bsmart-opts" role="group" aria-label="Columns">
            {SMART_COLUMNS.map((c) => (
              <label key={c} className="bsmart-opt">
                <input type="checkbox" checked={v.columns.includes(c)}
                  onChange={(e) => onChange({ columns: SMART_COLUMNS.filter((x) => (x === c ? e.target.checked : v.columns.includes(x))) })} /> {SMART_COLUMN_LABEL[c]}
              </label>
            ))}
          </div>
          <label className="bsmart-opt">
            <span>Sort by</span>
            <select value={v.order ?? ''} onChange={(e) => onChange({ order: (e.target.value || null) as SmartOrder | null })}>
              <option value="">None</option>
              {orders.map((p) => <option key={p} value={p}>{ORDER_LABELS[p]}</option>)}
            </select>
          </label>
          <label className="bsmart-opt">
            <input type="checkbox" checked={v.hideArchived} onChange={(e) => onChange({ hideArchived: e.target.checked })} /> Hide archived
          </label>
        </>
      )}
    </>
  );
}
