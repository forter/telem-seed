import { getPool } from './index';

export interface DeliveryAttempt {
  subscriber_id: number;
  message_key: string | null;
  payload: string;
  attempt_number: number;
  status: 'success' | 'failed' | 'exhausted' | 'blocked';
  http_status: number | null;
  error_message: string | null;
}

export async function logAttempt({
  subscriber_id,
  message_key,
  payload,
  attempt_number,
  status,
  http_status,
  error_message,
}: DeliveryAttempt): Promise<void> {
  await getPool().query(
    `INSERT INTO delivery_log
       (subscriber_id, message_key, payload, attempt_number, status, http_status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [subscriber_id, message_key ?? null, payload, attempt_number, status, http_status ?? null, error_message ?? null]
  );
}
