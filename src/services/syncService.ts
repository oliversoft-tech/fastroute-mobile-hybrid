import AsyncStorage from '@react-native-async-storage/async-storage';
import { Delivery } from '../types/delivery';
import { apiClient } from './apiClient';

const DELIVERIES_KEY = '@fastroute:deliveries';
const LAST_SYNC_KEY = '@fastroute:lastSync';

export class SyncService {
  async syncDeliveryConfirmations(): Promise<void> {
    try {
      const lastSync = await AsyncStorage.getItem(LAST_SYNC_KEY);
      const params = lastSync ? { since: lastSync } : {};
      
      const response = await apiClient.get<{ deliveries: Delivery[] }>(
        '/deliveries/confirmations/delta',
        { params }
      );

      const localDeliveries = await this.getLocalDeliveries();
      const updatedDeliveries = this.mergeConfirmations(localDeliveries, response.data.deliveries);
      
      await AsyncStorage.setItem(DELIVERIES_KEY, JSON.stringify(updatedDeliveries));
      await AsyncStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    }
  }

  private async getLocalDeliveries(): Promise<Delivery[]> {
    const data = await AsyncStorage.getItem(DELIVERIES_KEY);
    return data ? JSON.parse(data) : [];
  }

  private mergeConfirmations(local: Delivery[], remote: Delivery[]): Delivery[] {
    const remoteMap = new Map(remote.map(d => [d.id, d]));
    
    return local.map(delivery => {
      const remoteDelivery = remoteMap.get(delivery.id);
      if (remoteDelivery?.confirmation) {
        return {
          ...delivery,
          confirmation: remoteDelivery.confirmation,
          syncedAt: new Date().toISOString()
        };
      }
      return delivery;
    });
  }

  async getDeliveries(): Promise<Delivery[]> {
    return this.getLocalDeliveries();
  }
}

export const syncService = new SyncService();