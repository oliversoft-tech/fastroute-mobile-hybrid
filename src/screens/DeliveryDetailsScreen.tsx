import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SmsNotification, SmsNotificationStatus } from '../types/delivery';
import { notificationSyncService } from '../services/notification-sync.service';
import Icon from 'react-native-vector-icons/MaterialIcons';

interface Props {
  deliveryId: string;
}

export const DeliveryDetailsScreen: React.FC<Props> = ({ deliveryId }) => {
  const [notifications, setNotifications] = useState<SmsNotification[]>([]);

  useEffect(() => {
    loadNotifications();
  }, [deliveryId]);

  const loadNotifications = async () => {
    const notifs = await notificationSyncService.getNotificationsForDelivery(deliveryId);
    setNotifications(notifs.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()));
  };

  const getStatusColor = (status: SmsNotificationStatus): string => {
    switch (status) {
      case SmsNotificationStatus.Confirmed: return '#28a745';
      case SmsNotificationStatus.Rescheduled: return '#ffc107';
      case SmsNotificationStatus.AddressChanged: return '#17a2b8';
      default: return '#6c757d';
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notificações SMS</Text>
        {notifications.length === 0 ? (
          <Text style={styles.emptyText}>Nenhuma notificação enviada</Text>
        ) : (
          notifications.map(notif => (
            <View key={notif.id} style={styles.notificationCard}>
              <View style={styles.notificationHeader}>
                <View style={[styles.statusBadge, { backgroundColor: getStatusColor(notif.status) }]}>
                  <Text style={styles.statusText}>{notif.status}</Text>
                </View>
                <Text style={styles.dateText}>
                  {new Date(notif.sentAt).toLocaleString('pt-BR')}
                </Text>
              </View>
              {notif.residentResponse && (
                <View style={styles.responseContainer}>
                  <Icon name="chat-bubble" size={16} color="#6c757d" />
                  <Text style={styles.responseText}>{notif.residentResponse}</Text>
                  {notif.responseReceivedAt && (
                    <Text style={styles.responseDate}>
                      {new Date(notif.responseReceivedAt).toLocaleTimeString('pt-BR')}
                    </Text>
                  )}
                </View>
              )}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  section: { padding: 16, backgroundColor: '#fff', marginTop: 8 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 12 },
  emptyText: { color: '#6c757d', fontStyle: 'italic' },
  notificationCard: { backgroundColor: '#f8f9fa', padding: 12, borderRadius: 8, marginBottom: 8 },
  notificationHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  statusText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  dateText: { fontSize: 12, color: '#6c757d' },
  responseContainer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#dee2e6' },
  responseText: { flex: 1, fontSize: 14, color: '#495057' },
  responseDate: { fontSize: 11, color: '#6c757d' }
});