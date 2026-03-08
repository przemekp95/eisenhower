export interface Task {
  _id: string;
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type TaskInput = Omit<Task, '_id' | 'createdAt' | 'updatedAt'>;
