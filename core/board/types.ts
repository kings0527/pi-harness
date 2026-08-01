export interface Topic {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
}

export interface Note {
  seq: number;
  author: string;
  timestamp: number;
  tags?: string[];
  priority?: "critical";
  content: string;
}

export interface TopicMeta {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  noteCount: number;
}
