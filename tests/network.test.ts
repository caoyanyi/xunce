import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from '../server/network.ts';

describe('same-origin writes for arbitrary network addresses', () => {
  it.each([
    ['http://console.example.test:8080', 'console.example.test:8080'],
    ['https://console.example.test', 'console.example.test'],
    ['http://192.168.1.28:4318', '192.168.1.28:4318'],
    ['http://203.0.113.10:4318', '203.0.113.10:4318'],
    ['http://[::1]:4318', '[::1]:4318'],
    ['http://localhost:5173', '127.0.0.1:4318'],
  ])('accepts %s for %s', (origin, host) => {
    expect(isAllowedOrigin(origin, host)).toBe(true);
  });
  it.each([
    'https://evil.test',
    'http://console.example.test:9999',
    'null',
    'not a URL',
    'http://user:pass@console.example.test:8080',
    'http://console.example.test:8080/path',
  ])('rejects a cross-site or malformed origin: %s', (origin) => {
    expect(isAllowedOrigin(origin, 'console.example.test:8080')).toBe(false);
  });
});
