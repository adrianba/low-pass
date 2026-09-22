import { Lobby } from '../../src/network/lobby.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import { FaultNetwork } from './fault-transport.js';

export function lobbyPair() {
  const network = new FaultNetwork({ seed: 77, sessionId: 'lobby-fixture', epoch: 0,
    maxPackets: 16, maxBufferedBytes: 16 * 1024, maxInbox: 32 });
  const models = {
    host: new Lobby('host', DEFAULT_SETTINGS),
    guest: new Lobby('guest', { ...DEFAULT_SETTINGS, terrain: 'river-canyon', assist: false, quality: 'low' }),
  };
  const sequences = { host: 1, guest: 1 };
  function advance(ms = 20) {
    for (const role of ['host', 'guest'] as const) models[role].flush(body => {
      const result = network.peers[role].send({ version: 1, sessionId: 'lobby-fixture', epoch: 0,
        sender: role, sequence: sequences[role], ...body });
      if (result.ok) sequences[role]++;
      return result;
    });
    network.advanceTo(network.time + ms);
    for (const role of ['host', 'guest'] as const) for (const event of network.peers[role].drain()) {
      if (event.type !== 'message') throw new Error('Unexpected lobby transport event.');
      if (event.message.type === 'lobby-state') models[role].receiveState(event.message.state);
      else if (event.message.type === 'lobby-input') models[role].receiveInput(event.message.input);
      else throw new Error('Unexpected lobby message.');
    }
  }
  return { models, network, advance, settle() { for (let i = 0; i < 100; i++) advance(); } };
}
