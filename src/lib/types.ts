export interface Activity {
  id?: number;
  categoryId: string;
  name: string;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  daysOfWeek: number[]; // 0-6 (0 is Sunday or Monday? Let's use 0 = Monday, 1 = Tuesday...)
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
