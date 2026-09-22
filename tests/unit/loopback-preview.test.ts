import { describe, expect, it } from 'vitest';
import { loopbackPreview } from '../helpers/loopback-preview.js';

describe('private-code preview destination', () => {
  it('accepts only the declared loopback page before a test reads a real hosting code', () => {
    expect(loopbackPreview(undefined, '/room-controls.html')).toBeUndefined();
    expect(loopbackPreview('http://localhost:8080/room-controls.html', '/room-controls.html'))
      .toBe('http://localhost:8080/room-controls.html');
    for (const url of ['https://example.org/room-controls.html', 'file:///room-controls.html',
      'http://localhost:8080/other', 'http://user:password@localhost:8080/room-controls.html',
      'http://localhost:8080/room-controls.html?forward=elsewhere']) {
      expect(() => loopbackPreview(url, '/room-controls.html')).toThrow();
    }
  });
});
