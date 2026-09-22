import { BlockList, isIP, SocketAddress } from 'node:net';
import type { IncomingMessage } from 'node:http';

function normalized(value: string): string {
  const family = isIP(value);
  if (!family || value.includes('%')) throw new Error('Invalid client address.');
  const address = new SocketAddress({ address: value, family: family === 4 ? 'ipv4' : 'ipv6' }).address;
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export class ClientAddresses {
  private readonly trusted = new BlockList();
  constructor(cidrs: readonly string[]) {
    if (!cidrs.length || cidrs.length > 64) throw new Error('Trusted proxies require a bounded explicit CIDR list.');
    for (const cidr of cidrs) {
      const parts = cidr.split('/');
      if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) throw new Error('Invalid trusted proxy CIDR.');
      const address = normalized(parts[0]!), family = isIP(address), prefix = Number(parts[1]);
      if (prefix < 1 || prefix > (family === 4 ? 32 : 128)) throw new Error('Invalid trusted proxy CIDR.');
      this.trusted.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  private trusts(address: string): boolean {
    return this.trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  }
  read(request: IncomingMessage): string {
    const socket = normalized(request.socket.remoteAddress ?? '');
    if (!this.trusts(socket)) throw new Error('Untrusted immediate proxy.');
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !forwarded || forwarded.length > 2048) throw new Error('Missing or invalid client chain.');
    const parts = forwarded.split(',');
    if (parts.length > 16) throw new Error('Client chain exceeds its hop limit.');
    const addresses = parts.map(part => normalized(part.trim())).reverse();
    // Walk from the verified socket inward; never take a caller-supplied leftmost IP.
    for (const address of addresses) if (!this.trusts(address)) return address;
    throw new Error('Client chain contains no untrusted client address.');
  }
}
