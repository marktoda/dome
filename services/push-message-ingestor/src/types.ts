import type { MessageData } from '@communicator/common';

export type Bindings = {
  RAW_MESSAGES_QUEUE: Queue<MessageData>;
};
