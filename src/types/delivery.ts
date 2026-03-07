export enum SmsNotificationStatus {
  Sent = 'Enviado',
  Confirmed = 'Confirmado',
  Rescheduled = 'Reagendado',
  AddressChanged = 'EnderecoAlterado'
}

export interface SmsNotification {
  id: string;
  deliveryId: string;
  status: SmsNotificationStatus;
  sentAt: Date;
  residentResponse?: string;
  responseReceivedAt?: Date;
}

export interface DeliveryWithNotifications extends Delivery {
  smsNotifications: SmsNotification[];
  hasConfirmedNotification: boolean;
}

// file: src/services/notification-sync.service.ts

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SmsNotification } from '../types/delivery';
import { apiClient } from './api-client';

const NOTIFICATIONS_STORAGE_KEY = '@fastroute:notifications';

export class NotificationSyncService {
  async syncNotifications(deliveryIds: string[]): Promise<void> {
    try {
      const response = await apiClient.post<{ notifications: SmsNotification[] }>('/sync/notifications', { deliveryIds });
      const cached = await this.getCachedNotifications();
      const merged = { ...cached };
      
      response.data.notifications.forEach(notif => {
        if (!merged[notif.deliveryId]) merged[notif.deliveryId] = [];
        const existing = merged[notif.deliveryId].findIndex(n => n.id === notif.id);
        if (existing >= 0) merged[notif.deliveryId][existing] = notif;
        else merged[notif.deliveryId].push(notif);
      });
      
      await AsyncStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(merged));
    } catch (error) {
      console.error('Notification sync failed:', error);
    }
  }

  async getCachedNotifications(): Promise<Record<string, SmsNotification[]>> {
    const data = await AsyncStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  }

  async getNotificationsForDelivery(deliveryId: string): Promise<SmsNotification[]> {
    const cached = await this.getCachedNotifications();
    return cached[deliveryId] || [];
  }
}

export const notificationSyncService = new NotificationSyncService();