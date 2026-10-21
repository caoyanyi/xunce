import { describe, expect, it } from 'vitest';
import { inScope, isSafeNavigation, targetUrl, validateTask } from '../server/policy.ts';
import { task } from './helpers.ts';
describe('execution boundaries', () => {
  it('normalizes target URLs and drops fragments', () => {
    expect(targetUrl('https://example.com/a#b')).toBe('https://example.com/a');
  });
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'http://169.254.169.254',
    'garbage',
  ])('rejects unsafe target %s', (input) => {
    expect(() => targetUrl(input)).toThrow();
  });
  it('uses exact origin including port', () => {
    expect(inScope('http://localhost:123/a', 'http://localhost:123')).toBe(true);
    expect(inScope('http://localhost:124/a', 'http://localhost:123')).toBe(false);
    expect(inScope('https://example.com.evil.test', 'https://example.com')).toBe(false);
  });
  it.each(['/logout', '/orders/delete/1', '/checkout', '/api/%64elete'])(
    'avoids state-changing GET path %s',
    (path) => {
      expect(isSafeNavigation(`https://example.com${path}`)).toBe(false);
    },
  );
  it('rejects cross-origin navigation, malformed steps and writes without approval', () => {
    const url = 'https://example.com/';
    expect(() =>
      validateTask(
        task(url, { steps: [{ action: 'goto', url: 'https://evil.test' }] }),
        url,
        false,
      ),
    ).toThrow('超出');
    expect(() =>
      validateTask(
        task(url, { engine: 'midscene', steps: [{ action: 'aiAct', instruction: 'submit' }] }),
        url,
        false,
      ),
    ).toThrow('写操作');
    expect(() => validateTask(task(url, { steps: [] }), url, true)).toThrow();
    expect(() =>
      validateTask(
        task(url, { steps: [{ action: 'goto', url: 'https://example.com/logout' }] }),
        url,
        false,
      ),
    ).toThrow();
    expect(() => validateTask(task(url), url, false)).not.toThrow();
  });
});
