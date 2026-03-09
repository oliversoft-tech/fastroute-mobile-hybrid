import api from './api';
import { DeliveryConfirmation } from '../types/delivery.types';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CONFIRMATIONS_KEY = 'delivery_confirmations';

class DeliveryConfirmationService {
  async syncConfirmations(): Promise<void> {
    try {
      const response = await api.get<DeliveryConfirmation[]>('/delivery-confirmations/sync');
      await AsyncStorage.setItem(CONFIRMATIONS_KEY, JSON.stringify(response.data));
    } catch (error) {
      console.error('Sync confirmations error:', error);
    }
  }

  async getLocalConfirmations(): Promise<DeliveryConfirmation[]> {
    const data = await AsyncStorage.getItem(CONFIRMATIONS_KEY);
    return data ? JSON.parse(data) : [];
  }

  async getConfirmationHistory(deliveryId: number): Promise<DeliveryConfirmation[]> {
    try {
      const response = await api.get<DeliveryConfirmation[]>(`/delivery-confirmations/history/${deliveryId}`);
      return response.data;
    } catch (error) {
      const local = await this.getLocalConfirmations();
      return local.filter(c => c.delivery_id === deliveryId);
    }
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'confirmed': return '✓';
      case 'pending': return '⏱';
      case 'rescheduled': return '📅';
      case 'address_changed': return '📍';
      default: return '⏱';
    }
  }
}

export default new DeliveryConfirmationService();