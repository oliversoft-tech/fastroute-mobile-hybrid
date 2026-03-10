import { useState, useEffect } from 'react';
import { SmsStatus, NotificationInteraction } from '../types/notification.types';
import { apiService } from '../services/api.service';
import { useWebSocket } from './useWebSocket';

export const useNotifications = (deliveryId: string) => {
  const [smsStatuses, setSmsStatuses] = useState<SmsStatus[]>([]);
  const [interactions, setInteractions] = useState<NotificationInteraction[]>([]);
  const { subscribe, unsubscribe } = useWebSocket();

  useEffect(() => {
    loadNotifications();
    const channel = `delivery:${deliveryId}:notifications`;
    subscribe(channel, handleRealtimeUpdate);
    return () => unsubscribe(channel);
  }, [deliveryId]);

  const loadNotifications = async () => {
    try {
      const [statusesRes, interactionsRes] = await Promise.all([
        apiService.get(`/deliveries/${deliveryId}/sms-statuses`),
        apiService.get(`/deliveries/${deliveryId}/interactions`)
      ]);
      setSmsStatuses(statusesRes.data);
      setInteractions(interactionsRes.data);
    } catch (error) {
      console.error('Error loading notifications:', error);
    }
  };

  const handleRealtimeUpdate = (data: any) => {
    if (data.type === 'sms_status_update') {
      setSmsStatuses(prev => 
        prev.map(s => s.id === data.smsStatus.id ? data.smsStatus : s)
      );
    } else if (data.type === 'new_interaction') {
      setInteractions(prev => [data.interaction, ...prev]);
    }
  };

  const markAsProcessed = async (smsStatusId: string) => {
    try {
      const result = await apiService.patch(`/sms-statuses/${smsStatusId}/process`, {});
      setSmsStatuses(prev => 
        prev.map(s => s.id === smsStatusId ? result.data : s)
      );
    } catch (error) {
      console.error('Error marking as processed:', error);
    }
  };

  const overrideIntent = async (smsStatusId: string, newIntent: string, reason: string) => {
    try {
      const result = await apiService.post(`/sms-statuses/${smsStatusId}/override-intent`, {
        intent: newIntent,
        reason
      });
      setSmsStatuses(prev => 
        prev.map(s => s.id === smsStatusId ? result.data : s)
      );
      await loadNotifications();
    } catch (error) {
      console.error('Error overriding intent:', error);
    }
  };

  return {
    smsStatuses,
    interactions,
    markAsProcessed,
    overrideIntent,
    reload: loadNotifications
  };
};