import { inject } from 'vue';
import { Innertube } from 'youtubei.js/web';

export function useInnertube(): () => Promise<Innertube> {
  const getInnertube = inject('innertube') as () => Promise<Innertube>;
  if (!getInnertube) return () => Promise.reject(new Error('Innertube not initialized'));
  return getInnertube;
}