export interface ActivityStep {
  id: string;
  title: string;
  completed?: boolean;
}

export interface Activity {
  id?: number;
  categoryId: string;
  name: string;
  description?: string;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  daysOfWeek: number[]; // 0-6 (0 = Lunes, 6 = Domingo)
  steps?: ActivityStep[];
}

export interface Category {
  id: string;
  label: string;
  color: string;
  order: number;
}

export interface AppSettings {
  id: string;
  key: string;
  value: any;
}
