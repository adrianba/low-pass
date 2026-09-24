import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus, connectionRoute } from '../../src/ui/connection-status.js';
import type { MatchLink } from '../../src/network/lobby-connection.js';

type Report = Awaited<ReturnType<MatchLink['diagnostics']>>;
function report(local: string | null = 'host', remote: string | null = 'host', relayProtocol: string | null = null): Report {
  return { status: 'open', failure: null, peer: { status: 'open', failure: null, candidateFailures: 0,
    candidateErrorCodes: [], gathered: ['host', 'srflx', 'relay'],
    link: { connection: 'connected', ice: 'connected', control: 'open', state: 'open', sentHello: true,
      receivedHello: true, epoch: 1, pendingEpochMessages: 0, discardedEpochMessages: 0 },
    selected: { local, remote, protocol: 'udp', relayProtocol, rttMs: 10 } } };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('selected private flight connection', () => {
  it('uses the selected pair, not gathered candidates or the requested mode', () => {
    expect(connectionRoute(report())).toBe('Direct');
    expect(connectionRoute(report('prflx'))).toBe('Direct');
    expect(connectionRoute(report('srflx'))).toBe('Direct / STUN-assisted');
    expect(connectionRoute(report('host', 'srflx'))).toBe('Direct / STUN-assisted');
    for (const transport of ['udp', 'tcp', 'tls']) {
      expect(connectionRoute(report('relay', 'host', transport))).toBe(`TURN relay / ${transport.toUpperCase()}`);
    }
    expect(connectionRoute(report('host', 'relay'))).toBe('TURN relay');
    expect(connectionRoute(report('srflx', 'relay'))).toBe('TURN relay');
    expect(connectionRoute(report(null))).toBe('Connected / route unavailable');
    expect(connectionRoute({ status: 'open', failure: null, peer: null })).toBe('Connected / route unavailable');
    expect(connectionRoute({ ...report(), status: 'closed' })).toBe('Disconnected');
  });
  it('polls at most once per second without waiting and follows a route change', async () => {
    let now = 0;
    const status = new ConnectionStatus(() => now);
    const diagnostics = vi.fn(async () => report());
    const link = { status: 'open' as const, diagnostics };
    expect(status.update(link)).toBe('Checking route...');
    await flush();
    expect(status.update(link)).toBe('Direct');
    now = 999; status.update(link);
    expect(diagnostics).toHaveBeenCalledOnce();
    diagnostics.mockResolvedValue(report('relay', 'relay', 'tls'));
    now = 1000; status.update(link); await flush();
    expect(status.update(link)).toBe('TURN relay / TLS');
    expect(diagnostics).toHaveBeenCalledTimes(2);
  });
  it('ignores late results from replaced connections and clears on leave or recovery', async () => {
    const status = new ConnectionStatus(() => 0);
    let finish!: (value: Report) => void;
    const first = { status: 'open' as const, diagnostics: vi.fn(() => new Promise<Report>(resolve => { finish = resolve; })) };
    status.update(first); status.update(first);
    expect(first.diagnostics).toHaveBeenCalledOnce();
    expect(status.update(first, true)).toBe('Reconnecting...');
    const next = { status: 'open' as const, diagnostics: vi.fn(async () => report('relay', 'relay', 'tls')) };
    status.update(next); await flush();
    finish(report()); await flush();
    expect(status.update(next)).toBe('TURN relay / TLS');
    expect(status.update(null)).toBe('');
    expect(status.update({ ...next, status: 'closed' })).toBe('Disconnected');
    expect(status.update({ ...next, status: 'connecting' })).toBe('Connecting...');
  });
  it('surfaces unavailable diagnostics without stopping flight and recovers on a later observation', async () => {
    let now = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = new ConnectionStatus(() => now);
      const link = { status: 'open' as const, diagnostics: vi.fn<MatchLink['diagnostics']>().mockRejectedValue(new Error('private data')) };
      status.update(link); await flush();
      expect(status.update(link)).toBe('Connection details unavailable');
      now = 1000; status.update(link); await flush();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private data');
      link.diagnostics.mockResolvedValue(report());
      now = 2000; status.update(link); await flush();
      expect(status.update(link)).toBe('Direct');
    } finally { warn.mockRestore(); }
  });
});
