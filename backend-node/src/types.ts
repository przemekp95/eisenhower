export interface TaskPayload {
  title: string;
  description?: string;
  urgent: boolean;
  important: boolean;
}

export type HealthState = 'healthy' | 'unhealthy' | 'unreachable';
export type DatabaseState = 'connected' | 'disconnected';
