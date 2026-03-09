import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useNotifications } from '../hooks/useNotifications';
import { SmsStatus, NotificationInteraction } from '../types/notification.types';

interface DeliveryDetailsScreenProps {
  deliveryId: string;
}

export const DeliveryDetailsScreen: React.FC<DeliveryDetailsScreenProps> = ({ deliveryId }) => {
  const { smsStatuses, interactions, markAsProcessed, overrideIntent } = useNotifications(deliveryId);
  const [selectedSms, setSelectedSms] = useState<string | null>(null);

  const renderSmsStatus = ({ item }: { item: SmsStatus }) => (
    <View style={styles.smsCard}>
      <View style={styles.statusRow}>
        <Text style={styles.statusBadge}>{item.status.toUpperCase()}</Text>
        <Text style={styles.timestamp}>
          {new Date(item.sentAt).toLocaleString('pt-BR')}
        </Text>
      </View>
      {item.residentResponse && (
        <Text style={styles.response}>Resposta: {item.residentResponse}</Text>
      )}
      {item.residentIntent && (
        <Text style={styles.intent}>Intent: {item.residentIntent}</Text>
      )}
      <View style={styles.actions}>
        {!item.processedAt && (
          <TouchableOpacity
            style={styles.btnProcessed}
            onPress={() => markAsProcessed(item.id)}
          >
            <Text style={styles.btnText}>Marcar Processado</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.btnOverride}
          onPress={() => setSelectedSms(item.id)}
        >
          <Text style={styles.btnText}>Sobrescrever Intent</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderInteraction = ({ item }: { item: NotificationInteraction }) => (
    <View style={styles.interactionCard}>
      <View style={styles.interactionHeader}>
        <Text style={styles.origin}>{item.origin}</Text>
        <Text style={styles.timestamp}>
          {new Date(item.timestamp).toLocaleString('pt-BR')}
        </Text>
      </View>
      <Text style={styles.content}>{item.content}</Text>
      {item.operatorOverride && (
        <View style={styles.override}>
          <Text style={styles.overrideText}>
            Sobrescrito: {item.operatorOverride.overriddenIntent}
          </Text>
          <Text style={styles.overrideReason}>{item.operatorOverride.reason}</Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Notificações SMS</Text>
      <FlatList
        data={smsStatuses}
        keyExtractor={(item) => item.id}
        renderItem={renderSmsStatus}
        style={styles.smsList}
      />
      <Text style={styles.sectionTitle}>Histórico de Interações</Text>
      <FlatList
        data={interactions}
        keyExtractor={(item) => item.id}
        renderItem={renderInteraction}
        style={styles.interactionsList}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 12 },
  smsCard: { backgroundColor: '#fff', padding: 12, marginBottom: 8, borderRadius: 8 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  statusBadge: { fontSize: 12, fontWeight: 'bold', color: '#007bff' },
  timestamp: { fontSize: 12, color: '#666' },
  response: { fontSize: 14, marginBottom: 4 },
  intent: { fontSize: 14, fontStyle: 'italic', marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 8 },
  btnProcessed: { backgroundColor: '#28a745', padding: 8, borderRadius: 4, flex: 1 },
  btnOverride: { backgroundColor: '#ffc107', padding: 8, borderRadius: 4, flex: 1 },
  btnText: { color: '#fff', textAlign: 'center', fontSize: 12 },
  smsList: { marginBottom: 16 },
  interactionCard: { backgroundColor: '#fff', padding: 12, marginBottom: 8, borderRadius: 8 },
  interactionHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  origin: { fontSize: 12, fontWeight: 'bold', color: '#333' },
  content: { fontSize: 14, marginBottom: 4 },
  override: { backgroundColor: '#fff3cd', padding: 8, borderRadius: 4, marginTop: 4 },
  overrideText: { fontSize: 12, fontWeight: 'bold' },
  overrideReason: { fontSize: 12, color: '#666' },
  interactionsList: { flex: 1 }
});