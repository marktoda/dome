export interface SourceItem {
  id: string;
  title: string;
  source: string;
  url?: string;
  relevanceScore: number;
}

export type Message = {
  id: string;
  text: string;
  sender: 'user' | 'assistant' | 'system'; // Added 'system'
  timestamp: Date;
  sources?: SourceItem[];
};

export type ChatContextType = {
  messages: Message[];
  addMessage: (text: string) => Promise<void>;
  isLoading: boolean;
};
