export type ConfirmationStatus = 'pending' | 'confirmed' | 'rescheduled' | 'address_changed';

export interface DeliveryConfirmation {
  status: ConfirmationStatus;
  confirmedAt?: string;
  smsResponse?: string;
  notes?: string;
}

export interface Delivery {
  id: string;
  customerId: string;
  customerName: string;
  address: string;
  scheduledDate: string;
  status: 'pending' | 'in_progress' | 'delivered' | 'failed';
  confirmation?: DeliveryConfirmation;
  syncedAt?: string;
}