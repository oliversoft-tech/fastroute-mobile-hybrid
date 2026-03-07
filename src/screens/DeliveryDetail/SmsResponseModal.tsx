import React, { useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { SmsResponse, SmsActionType } from '../../types/sms';
import { overrideSmsAction } from '../../services/smsService';

interface SmsResponseModalProps {
  visible: boolean;
  smsResponse: SmsResponse | null;
  deliveryId: string;
  onClose: () => void;
  onOverrideSuccess: () => void;
}

export const SmsResponseModal: React.FC<SmsResponseModalProps> = ({
  visible,
  smsResponse,
  deliveryId,
  onClose,
  onOverrideSuccess
}) => {
  const [loading, setLoading] = useState(false);

  const handleOverride = async (newAction: SmsActionType) => {
    Alert.alert(
      'Confirmar Override',
      `Deseja sobrescrever a ação de "${smsResponse?.action_taken}" para "${newAction}"?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          onPress: async () => {
            setLoading(true);
            try {
              await overrideSmsAction(deliveryId, smsResponse!.id, newAction);
              Alert.alert('Sucesso', 'Ação sobrescrita com sucesso');
              onOverrideSuccess();
              onClose();
            } catch (error) {
              Alert.alert('Erro', 'Falha ao sobrescrever ação. Tente novamente.');
            } finally {
              setLoading(false);
            }
          }
        }
      ]
    );
  };

  if (!smsResponse) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <Text style={styles.title}>Detalhes da Resposta SMS</Text>
          <ScrollView style={styles.content}>
            <View style={styles.section}>
              <Text style={styles.label}>Texto Original:</Text>
              <Text style={styles.value}>{smsResponse.original_text}</Text>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Data da Resposta:</Text>
              <Text style={styles.value}>{new Date(smsResponse.received_at).toLocaleString('pt-BR')}</Text>
            </View>
            <View style={styles.section}>
              <Text style={styles.label}>Ação Tomada:</Text>
              <Text style={[styles.value, styles.actionBadge]}>{smsResponse.action_taken}</Text>
            </View>
            {smsResponse.override_by && (
              <View style={styles.section}>
                <Text style={styles.label}>Override por:</Text>
                <Text style={styles.value}>{smsResponse.override_by} em {new Date(smsResponse.override_at!).toLocaleString('pt-BR')}</Text>
              </View>
            )}
            <View style={styles.section}>
              <Text style={styles.label}>Histórico de Ações:</Text>
              {smsResponse.action_history?.map((h, idx) => (
                <Text key={idx} style={styles.historyItem}>
                  {new Date(h.timestamp).toLocaleTimeString('pt-BR')} - {h.action} {h.by_user ? `(por ${h.by_user})` : ''}
                </Text>
              ))}
            </View>
          </ScrollView>
          <View style={styles.actions}>
            <Text style={styles.overrideLabel}>Sobrescrever ação:</Text>
            <TouchableOpacity
              style={[styles.button, styles.ignoreButton]}
              onPress={() => handleOverride('ignore')}
              disabled={loading}
            >
              <Text style={styles.buttonText}>Ignorar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.retryButton]}
              onPress={() => handleOverride('retry_delivery')}
              disabled={loading}
            >
              <Text style={styles.buttonText}>Retentar Entrega</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.closeButton]} onPress={onClose}>
              <Text style={styles.buttonText}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  container: { width: '90%', maxHeight: '80%', backgroundColor: '#fff', borderRadius: 12, padding: 20 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
  content: { maxHeight: 400 },
  section: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 4 },
  value: { fontSize: 16, color: '#000' },
  actionBadge: { backgroundColor: '#e3f2fd', padding: 8, borderRadius: 6, overflow: 'hidden' },
  historyItem: { fontSize: 14, color: '#666', marginTop: 4 },
  actions: { marginTop: 16, borderTopWidth: 1, borderTopColor: '#ddd', paddingTop: 16 },
  overrideLabel: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  button: { paddingVertical: 12, borderRadius: 8, marginBottom: 8, alignItems: 'center' },
  ignoreButton: { backgroundColor: '#ff9800' },
  retryButton: { backgroundColor: '#4caf50' },
  closeButton: { backgroundColor: '#757575' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' }
});