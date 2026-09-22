import type { Plugin } from 'vite';
export interface IdentityDigests { build: string; assets: string; rules: string; generator: string }
export function identityDigests(root: string): IdentityDigests;
export function identityPlugin(root?: string): Plugin;
