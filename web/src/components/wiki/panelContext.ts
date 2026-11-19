import { createContext, useContext } from 'react';
import type { Card } from '../../../../shared/types';

/**
 * Given to everything inside one column of the wiki's entry stack (the main entry is column 0, panels 1…): opens an
 * entry as a panel to the right of that column. Outside the stack (other pages, the campaign graph) there is none, and
 * links navigate as usual.
 */
export interface PanelOpener {
  column: number;
  /** Opens the entry beside this column. */
  openCard(card: Card): void;
  /** Opens the wiki entry this in-app href names beside this column; false when it is not one of this wiki's entries. */
  openHref(href: string): boolean;
}

export const PanelContext = createContext<PanelOpener | null>(null);
export const usePanelOpener = (): PanelOpener | null => useContext(PanelContext);
