export interface SmsStatus {
  id: string;
  deliveryId: string;
  status: 'sent' | 'confirmed' | 'pending' | 'failed';
  sentAt: Date;
  confirmedAt?: Date;
  residentResponse?: string;
  residentIntent?: 'confirm' | 'reschedule' | 'reject' | 'unknown';
  origin: 'resident' | 'system' | 'operator';
  processedByOperatorId?: string;
  processedAt?: Date;
}

export interface NotificationInteraction {
  id: string;
  smsStatusId: string;
  timestamp: Date;
  origin: 'resident' | 'system' | 'operator';
  content: string;
  intentExtracted?: string;
  operatorOverride?: {
    operatorId: string;
    overriddenIntent: string;
    reason: string;
    timestamp: Date;
  };
}