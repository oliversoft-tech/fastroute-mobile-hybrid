export type DeliveryConfirmationStatus = 'confirmed' | 'pending' | 'rescheduled' | 'address_changed';

export interface DeliveryConfirmation {
  id: number;
  delivery_id: number;
  status: DeliveryConfirmationStatus;
  sms_sent_at: string | null;
  response_received_at: string | null;
  response_action: string | null;
  synced: boolean;
  created_at: string;
  updated_at: string;
}

export interface Delivery {
  id: number;
  customer_name: string;
  address: string;
  scheduled_date: string;
  status: string;
  confirmation?: DeliveryConfirmation;
}

export interface DeliveryFilter {
  confirmation_status?: DeliveryConfirmationStatus | 'pending_only' | 'confirmed_only';
}