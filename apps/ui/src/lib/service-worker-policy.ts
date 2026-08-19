export interface ServiceWorkerEnvironment {
  serviceWorkerSupported: boolean;
  protocol: string;
  isElectron: boolean;
}

export function shouldRegisterServiceWorker(environment: ServiceWorkerEnvironment): boolean {
  return (
    environment.serviceWorkerSupported &&
    !environment.isElectron &&
    !environment.protocol.startsWith('file')
  );
}
