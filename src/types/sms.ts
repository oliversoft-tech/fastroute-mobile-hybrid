export type SmsActionType = 'reschedule' | 'cancel' | 'retry_delivery' | 'ignore' | 'delivered';

export interface SmsResponse {
  id: number;
  delivery_id: string;
  original_text: string;
  received_at: string;
  action_taken: SmsActionType;
  override_by?: string;
  override_at?: string;
  action_history?: Array<{
    timestamp: string;
    action: SmsActionType;
    by_user?: string;
  }>;
}