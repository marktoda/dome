import { Annotation } from '@langchain/langgraph';
import type {
  Message,
  MessagePair,
  RetrievalTask,
  Document,
  SourceMetadata,
  RetrievalEvaluation,
  ToolNecessityClassification,
  ToolRoutingDecision,
} from '../types';
import { AgentStateV3 } from './stateSlices';
import { merge } from '../types';

export const GraphStateAnnotationV3 = Annotation.Root({
  /* Required scalar */
  userId: Annotation<string>(),

  /* Conversation */
  messages: Annotation<Message[]>(),
  chatHistory: Annotation<MessagePair[]>(),

  /* Retrieval */
  retrievals: Annotation<RetrievalTask[]>(),
  docs: Annotation<Document[]>(),
  sources: Annotation<SourceMetadata[]>(),

  /* Reasoning & Instructions */
  reasoning: Annotation<string[]>(),
  instructions: Annotation<string>(),

  /* Decisions */
  retrievalEvaluation: Annotation<RetrievalEvaluation>(),
  toolNecessityClassification: Annotation<ToolNecessityClassification>(),
  toolRoutingDecision: Annotation<ToolRoutingDecision>(),

  /* Generation */
  generatedText: Annotation<string>(),

  /* Config */
  options: Annotation<AgentStateV3['options']>(),

  /* Metadata */
  metadata: merge<AgentStateV3['metadata']>(),

  /* Task IDs and Entities */
  taskIds: Annotation<string[]>(),
  taskEntities: merge<Record<string, any>>(),

  /* Tool requirements */
  toolRequirements: merge<Record<string, any>>(),
});
