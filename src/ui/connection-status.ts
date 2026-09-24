import type { MatchLink } from '../network/lobby-connection.js';

type Link = Pick<MatchLink, 'status' | 'diagnostics'>;
type Report = Awaited<ReturnType<Link['diagnostics']>>;

export function connectionRoute(report: Report): string {
  if (report.status !== 'open') return report.status === 'connecting' ? 'Connecting...' : 'Disconnected';
  const selected = report.peer?.selected;
  if (!selected) return 'Connected / route unavailable';
  if (selected.local === 'relay' || selected.remote === 'relay') {
    const transport = selected.local === 'relay' ? selected.relayProtocol : null;
    return `TURN relay${transport ? ` / ${transport.toUpperCase()}` : ''}`;
  }
  if (!selected.local || !selected.remote) return 'Connected / route unavailable';
  return selected.local === 'srflx' || selected.remote === 'srflx' ? 'Direct / STUN-assisted' : 'Direct';
}

/** Diagnostic polling never blocks the flight loop or retains a replaced peer's route. */
export class ConnectionStatus {
  private link: Link | null = null;
  private revision = 0;
  private sampledAt = -Infinity;
  private pending = false;
  private label = 'Checking route...';
  private unavailable = false;
  constructor(private readonly now: () => number = () => performance.now()) {}
  update(link: Link | null, recovering = false): string {
    if (link !== this.link) {
      this.link = link; this.revision++; this.sampledAt = -Infinity; this.pending = false;
      this.label = 'Checking route...'; this.unavailable = false;
    }
    if (recovering) return 'Reconnecting...';
    if (!link) return '';
    if (link.status !== 'open') return link.status === 'connecting' ? 'Connecting...' : 'Disconnected';
    const now = this.now();
    if (!this.pending && now - this.sampledAt >= 1000) {
      this.pending = true; this.sampledAt = now;
      const revision = this.revision;
      void link.diagnostics().then(report => {
        if (this.revision !== revision) return;
        this.label = connectionRoute(report); this.unavailable = false;
      }).catch(() => {
        if (this.revision !== revision) return;
        this.label = 'Connection details unavailable';
        if (!this.unavailable) console.warn('Private connection details unavailable; flight transport is unchanged.');
        this.unavailable = true;
      }).finally(() => { if (this.revision === revision) this.pending = false; });
    }
    return this.label;
  }
}
