import { useSyncExternalStore } from 'react';

export interface Toast { id: number; text: string; tone: 'info' | 'error' }

const MAX = 4; // older toasts are dropped; the list never grows unbounded
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

export function showToast(text: string, tone: Toast['tone'] = 'error', ms = 6000): void {
  const t = { id: nextId++, text, tone };
  toasts = [...toasts, t].slice(-MAX);
  emit();
  setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const useToasts = () =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => toasts);
