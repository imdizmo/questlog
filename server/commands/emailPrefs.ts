import { z } from 'zod';
import type { Command } from '../dispatch';
import { assertCan } from '../permissions';
import { NOTIFICATION_PREFS, setEmailPrefs } from '../email';

/** A person's own email preferences (Settings > Email notifications). Session only: `emailPrefs` is token-denied. */
export const emailPrefCommands: Record<string, Command> = {
  'emailPrefs/update': {
    schema: z.object({ notifications: z.enum(NOTIFICATION_PREFS) }),
    run(ctx, { notifications }) {
      assertCan(ctx.db, ctx.actor, 'workspace.personal');
      setEmailPrefs(ctx.db, ctx.actor.id, notifications);
      return { notifications };
    },
  },
};
