import { useEffect, useState } from 'react';
import { fetchLoginProviders, type LoginProviders } from '../services/auth';

/** The OAuth sign-ins that work on this deployment; null while asking the server (show none yet). */
export function useLoginProviders(): LoginProviders | null {
  const [providers, setProviders] = useState<LoginProviders | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchLoginProviders().then((p) => {
      if (!cancelled) setProviders(p);
    });
    return (): void => {
      cancelled = true;
    };
  }, []);
  return providers;
}
