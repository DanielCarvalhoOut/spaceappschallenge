import { describe, expect, it } from 'vitest';
import { corsAllows } from '../server.js';

describe('CORS', () => {
  it('accepts the configured localhost front on any port, and refuses other sites', () => {
    const allow = corsAllows('http://localhost:8080');
    expect(allow('http://localhost:8080')).toBe(true);
    expect(allow('http://localhost:5500')).toBe(true);
    expect(allow('http://127.0.0.1:51053')).toBe(true);
    expect(allow('https://evil.example')).toBe(false);
    expect(allow('http://localhost.evil.example:80')).toBe(false);
  });
  it('a deployed front only accepts its own origin', () => {
    const allow = corsAllows('https://cinder.example.org');
    expect(allow('https://cinder.example.org')).toBe(true);
    expect(allow('http://localhost:5500')).toBe(false);
  });
});
