import { httpClient } from './httpClient';
import { ClusterResult } from './types';

export async function clusterizeAddresses(eps: number) {
  const { data } = await httpClient.post<ClusterResult[]>('clusterize', { eps });
  return data;
}
