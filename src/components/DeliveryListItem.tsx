import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { Delivery, ConfirmationStatus } from '../types/delivery';

interface Props {
  delivery: Delivery;
  onPress: () => void;
}

const STATUS_COLORS: Record<ConfirmationStatus, string> = {
  pending: '#FFA500',
  confirmed: '#4CAF50',
  rescheduled: '#2196F3',
  address_changed: '#9C27B0'
};

const STATUS_LABELS: Record<ConfirmationStatus, string> = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  rescheduled: 'Reagendado',
  address_changed: 'End. Alterado'
};

export const DeliveryListItem: React.FC<Props> = ({ delivery, onPress }) => {
  const [modalVisible, setModalVisible] = useState(false);
  const confirmation = delivery.confirmation;

  const handleBadgePress = () => {
    if (confirmation?.smsResponse) {
      setModalVisible(true);
    }
  };

  return (
    <TouchableOpacity style={styles.container} onPress={onPress}>
      <View style={styles.header}>
        <Text style={styles.customerName}>{delivery.customerName}</Text>
        {confirmation && (
          <TouchableOpacity
            style={[styles.badge, { backgroundColor: STATUS_COLORS[confirmation.status] }]}
            onPress={handleBadgePress}
          >
            <Text style={styles.badgeText}>{STATUS_LABELS[confirmation.status]}</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.address}>{delivery.address}</Text>
      <Text style={styles.date}>{new Date(delivery.scheduledDate).toLocaleDateString('pt-BR')}</Text>

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setModalVisible(false)}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Detalhes da Confirmação</Text>
            <Text style={styles.modalLabel}>Status:</Text>
            <Text style={styles.modalValue}>{STATUS_LABELS[confirmation!.status]}</Text>
            {confirmation?.confirmedAt && (
              <>
                <Text style={styles.modalLabel}>Confirmado em:</Text>
                <Text style={styles.modalValue}>
                  {new Date(confirmation.confirmedAt).toLocaleString('pt-BR')}
                </Text>
              </>
            )}
            {confirmation?.smsResponse && (
              <>
                <Text style={styles.modalLabel}>Resposta SMS:</Text>
                <Text style={styles.modalValue}>{confirmation.smsResponse}</Text>
              </>
            )}
            {confirmation?.notes && (
              <>
                <Text style={styles.modalLabel}>Observações:</Text>
                <Text style={styles.modalValue}>{confirmation.notes}</Text>
              </>
            )}
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.closeButtonText}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
    padding: 16,
    marginVertical: 4,
    borderRadius: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  customerName: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600'
  },
  address: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4
  },
  date: {
    fontSize: 12,
    color: '#999'
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    width: '85%',
    maxWidth: 400
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16
  },
  modalLabel: {
    fontSize: 12,
    color: '#666',
    marginTop: 12,
    marginBottom: 4
  },
  modalValue: {
    fontSize: 14,
    color: '#333'
  },
  closeButton: {
    backgroundColor: '#2196F3',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 20
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  }
});