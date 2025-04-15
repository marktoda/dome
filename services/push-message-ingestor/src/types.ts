import { BaseMessage } from "./models/message";

export type Bindings = {
  RAW_MESSAGES_QUEUE: Queue<BaseMessage>;
}

