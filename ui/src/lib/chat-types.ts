export type Message = {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
};

export type ChatContextType = {
  messages: Message[];
  addMessage: (text: string) => Promise<void>;
  isLoading: boolean;
};