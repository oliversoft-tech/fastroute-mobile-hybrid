import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Delivery, DeliveryConfirmation, DeliveryFilter } from '../types/delivery.types';
import deliveryConfirmationService from '../services/deliveryConfirmationService';
import NetInfo from '@react-native-community/netinfo';

export default function DeliveryListScreen() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState<DeliveryFilter>({});
  const [selectedHistory, setSelectedHistory] = useState<DeliveryConfirmation[]>([]);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    loadDeliveries();
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected) {
        deliveryConfirmationService.syncConfirmations().then(() => loadDeliveries());
      }
    });
    return () => unsubscribe();
  }, []);

  const loadDeliveries = async () => {
    await deliveryConfirmationService.syncConfirmations();
    const confirmations = await deliveryConfirmationService.getLocalConfirmations();
    const mockDeliveries: Delivery[] = [
      { id: 1, customer_name: 'João Silva', address: 'Rua A, 123', scheduled_date: '2025-06-10', status: 'pending', confirmation: confirmations.find(c => c.delivery_id === 1) },
      { id: 2, customer_name: 'Maria Santos', address: 'Av B, 456', scheduled_date: '2025-06-11', status: 'pending', confirmation: confirmations.find(c => c.delivery_id === 2) }
    ];
    setDeliveries(applyFilter(mockDeliveries));
  };

  const applyFilter = (list: Delivery[]): Delivery[] => {
    if (filter.confirmation_status === 'pending_only') return list.filter(d => d.confirmation?.status === 'pending' || !d.confirmation);
    if (filter.confirmation_status === 'confirmed_only') return list.filter(d => d.confirmation?.status === 'confirmed');
    return list;
  };

  const openHistory = async (deliveryId: number) => {
    const history = await deliveryConfirmationService.getConfirmationHistory(deliveryId);
    setSelectedHistory(history);
    setModalVisible(true);
  };

  const renderItem = ({ item }: { item: Delivery }) => (
    <View style={styles.card}>
      <Text style={styles.customer}>{item.customer_name}</Text>
      <Text>{item.address}</Text>
      <TouchableOpacity onPress={() => openHistory(item.id)} style={styles.badge}>
        <Text style={styles.badgeText}>{deliveryConfirmationService.getStatusIcon(item.confirmation?.status || 'pending')} {item.confirmation?.status || 'Pendente'}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        <TouchableOpacity onPress={() => setFilter({})}>All</TouchableOpacity>
        <TouchableOpacity onPress={() => setFilter({ confirmation_status: 'pending_only' })}>Pendentes</TouchableOpacity>
        <TouchableOpacity onPress={() => setFilter({ confirmation_status: 'confirmed_only' })}>Confirmadas</TouchableOpacity>
      </View>
      <FlatList data={deliveries} renderItem={renderItem} keyExtractor={item => item.id.toString()} />
      <Modal visible={modalVisible} onRequestClose={() => setModalVisible(false)} transparent>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Histórico de SMS</Text>
          {selectedHistory.map(h => (
            <Text key={h.id}>Enviado: {h.sms_sent_at}, Resposta: {h.response_received_at}, Ação: {h.response_action}</Text>
          ))}
          <TouchableOpacity onPress={() => setModalVisible(false)}><Text>Fechar</Text></TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  filterRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 },
  card: { padding: 12, backgroundColor: '#fff', marginBottom: 8, borderRadius: 8 },
  customer: { fontWeight: 'bold' },
  badge: { marginTop: 8, padding: 4, backgroundColor: '#e0e0e0', borderRadius: 4 },
  badgeText: { fontSize: 12 },
  modal: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 12 }
});