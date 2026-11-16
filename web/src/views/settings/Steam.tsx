/** Workspace settings > Steam: nothing to connect, only a note. */
export function SteamIntegration() {
  return (
    <div className="settings-stack" aria-label="Steam settings">
      <section className="settings-group">
        <h3 className="sub">Steam</h3>
        <p className="hint">
          Steam reviews are not connected to this workspace. There is no review feed and nothing to set up here.
        </p>
        <p className="hint">
          If you want Steam reviews next to your tasks, use a separate bot or script that posts them to a Discord or Slack channel
          (see those tabs for project news in the other direction), or add the interesting ones as tasks by hand.
        </p>
      </section>
    </div>
  );
}
