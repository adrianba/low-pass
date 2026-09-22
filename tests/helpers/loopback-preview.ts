export function loopbackPreview(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== path || url.search || url.hash) {
    throw new Error('Tests using the private local hosting code require the expected loopback preview URL.');
  }
  return url.href;
}
