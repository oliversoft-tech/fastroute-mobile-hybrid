import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { DeliveryWithNotifications, SmsNotificationStatus } from '../types/delivery';

interface Props {
  delivery: DeliveryWithNotifications;
  onPress: () => void;
}

export const DeliveryListItem: React.FC<Props> = ({ delivery, onPress }) => {
  const hasConfirmation = delivery.smsNotifications.some(n => n.status === SmsNotificationStatus.Confirmed);
  const hasResponse = delivery.smsNotifications.some(n => n.residentResponse);

  return (
    <TouchableOpacity style={styles.container} onPress={onPress}>
      <View style={styles.content}>
        <Text style={styles.address}>{delivery.address}</Text>
        <Text style={styles.recipient}>{delivery.recipientName}</Text>
      </View>
      {hasConfirmation && (
        <View style={styles.confirmationBadge}>
          <Icon name="check-circle" size={20} color="#28a745" />
        </View>
      )}
      {!hasConfirmation && hasResponse && (
        <View style={styles.responseBadge}>
          <Icon name="chat-bubble" size={18} color="#17a2b8" />
        </View>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: { flexDirection: 'row', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#dee2e6', alignItems: 'center' },
  content: { flex: 1 },
  address: { fontSize: 16, fontWeight: '600', color: '#212529' },
  recipient: { fontSize: 14, color: '#6c757d', marginTop: 4 },
  confirmationBadge: { marginLeft: 12 },
  responseBadge: { marginLeft: 12 }
});