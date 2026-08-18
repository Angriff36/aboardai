import { describe, expect, it } from 'vitest';
import { shouldRegisterServiceWorker } from '@/lib/service-worker-policy';

describe('shouldRegisterServiceWorker', () => {
  it('registers the PWA service worker in an HTTP browser', () => {
    expect(
      shouldRegisterServiceWorker({
        serviceWorkerSupported: true,
        protocol: 'https:',
        isElectron: false,
      })
    ).toBe(true);
  });

  it('does not register the PWA service worker inside Electron', () => {
    expect(
      shouldRegisterServiceWorker({
        serviceWorkerSupported: true,
        protocol: 'http:',
        isElectron: true,
      })
    ).toBe(false);
  });

  it.each([
    { serviceWorkerSupported: false, protocol: 'https:', isElectron: false },
    { serviceWorkerSupported: true, protocol: 'file:', isElectron: false },
  ])('does not register for unsupported environments: $protocol', (environment) => {
    expect(shouldRegisterServiceWorker(environment)).toBe(false);
  });
});
