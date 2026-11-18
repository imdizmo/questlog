// Logs an uncaught exception or unhandled rejection with its stack, then exits. Without this the process dies
// with Node's default output, which the log does not always capture in a usable form.
export function installFatalHandlers(
  proc: NodeJS.EventEmitter & { exit(code: number): never },
  log: (line: string) => void,
): void {
  const fatal = (kind: string) => (reason: unknown) => {
    const isError = reason instanceof Error;
    const message = isError ? reason.message : String(reason);
    const stack = isError && reason.stack ? `\n${reason.stack}` : '';
    log(`[jt] fatal ${kind}: ${message}${stack}`);
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal('uncaughtException'));
  proc.on('unhandledRejection', fatal('unhandledRejection'));
}
