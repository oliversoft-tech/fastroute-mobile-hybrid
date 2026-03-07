import axios from 'axios';
import { API_BASE_URL } from '../config';
import { getAuthToken } from './authService';
import { SmsActionType } from '../types/sms';

export const overrideSmsAction = async (
  deliveryId: string,
  smsResponseId: number,
  newAction: SmsActionType
): Promise<void> => {
  const token = await getAuthToken();
  await axios.post(
    `${API_BASE_URL}/deliveries/${deliveryId}/sms-responses/${smsResponseId}/override`,
    { new_action: newAction },
    { headers: { Authorization: `Bearer ${token}` } }
  );
};