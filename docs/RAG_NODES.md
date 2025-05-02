## RAG Pipeline Graph Design Document

### High-Level Graph Structure

```
                 ┌───────────────┐
                 │   splitRoute  │
                 └───────┬───────┘
                         │
              ┌──────────▼──────────┐
              │ retrievalSelector   │
              └──────────┬──────────┘
                         │
                  ┌──────▼───────┐
                  │   retrieve   │
                  └───┬───┬───┬──┘
                      │   │   │
        ┌─────────────┘   │   └──────────────┐
┌───────▼───────┐ ┌───────▼───────┐ ┌─────────▼─────────┐
│CodeRetriever  │ │NotesRetriever │ │DocsRetriever      │
└───────┬───────┘ └───────┬───────┘ └─────────┬─────────┘
        │                 │                   │
┌───────▼───────┐ ┌───────▼───────┐ ┌─────────▼─────────┐
│codeReranker   │ │notesReranker  │ │docsReranker       │
└───────┬───────┘ └───────┬───────┘ └─────────┬─────────┘
        └───────────┬─────┴───────────┘
                    │
         ┌──────────▼───────────┐
         │ retrievalEvaluatorLLM│
         └───────────┬──────────┘
                     │
          ┌──────────▼───────────┐
          │toolNecessityClassifier│
          └──────────┬───────────┘
                     │
           ┌─────────▼─────────┐
           │   toolRouterLLM   │─────No───┐
           └─────────┬─────────┘          │
                     │Yes                 │
                 ┌───▼───┐                │
                 │runTool│                │
                 └───┬───┘                │
                     │                    │
         ┌───────────▼───────────┐        │
         │ combineContextLLM     │◄───────┘
         └───────────┬───────────┘
                     │
           ┌─────────▼─────────┐
           │   generateAnswer  │
           └─────────┬─────────┘
                     │
           ┌─────────▼─────────┐
           │  outputGuardrail  │
           └───────────────────┘
```

### Node Descriptions and Logic

#### 1. **splitRoute**

- **Purpose:** Parse and split incoming user queries into distinct tasks.
- **Implementation:** LLM generates structured tasks with clear instructions.

#### 2. **retrievalSelector**

- **Purpose:** Dynamically select retrieval types (code, notes, notion docs) for each subtask.
- **Implementation:** LLM-based classifier outputting retrieval sources explicitly per task.

#### 3. **retrieve** (Unified Interface)

- **Purpose:** Dispatch retrieval to multiple retrievers in parallel based on the subtask requirements.
- **Implementation:** Defines a unified `Retriever` interface implemented by Code, Notes, and Docs retrievers. Each retriever performs semantic search independently.

#### 4. **Retrievers** (Implementing the Retriever Interface)

- **CodeRetriever:** Semantic search within embedded GitHub code.
- **NotesRetriever:** Semantic search within user's personal notes.
- **DocsRetriever:** Semantic search within Notion documents (public and private based on user permissions).

**Retriever Interface:**

```typescript
interface Retriever {
  retrieve(query: string): Promise<DocumentChunk[]>;
}
```

#### 5. **Rerankers** (NEW for all retrieval types)

- **Purpose:** Improve retrieval precision across documents, notes, and code.
- **Implementation:** Cross-encoder reranker (e.g., BGE-reranker, Cohere Rerank) selecting the top 8 most relevant chunks.
- **Rationale:** Enhances precision, reduces context size, and increases downstream quality.

#### 6. **retrievalEvaluatorLLM**

- **Purpose:** Evaluate relevance and sufficiency of retrieved content post-reranking.
- **Implementation:** LLM-based scoring and binary adequacy decision.

#### 7. **toolNecessityClassifier**

- **Purpose:** Determine if external tools (e.g., web search) are necessary based on retrieval quality.
- **Implementation:** LLM binary classifier providing explicit reasons.

#### 8. **toolRouterLLM**

- **Purpose:** Select appropriate external tools based on task context and necessity.
- **Implementation:** LLM selection from available tools (currently web search).

#### 9. **runTool**

- Executes selected tools and stores clearly labeled results.

#### 10. **combineContextLLM**

- **Purpose:** Synthesize retrieved and tool-derived content into a coherent prompt-ready context.
- **Implementation:** LLM assembles context with explicit labeling of sources.

#### 11. **generateAnswer**

- **Purpose:** Generate the final comprehensive answer based strictly on combined context.
- **Implementation:** GPT-4 Turbo or other state-of-the-art generative LLM.

#### 12. **outputGuardrail**

- **Purpose:** Validate the answer for accuracy, compliance, and lack of hallucination.
- **Implementation:** LLM-driven validation providing corrective feedback if necessary.

### Practical Hyperparameters

- **Initial Vector Retrieval:** Top 30 candidates.
- **Cross-Encoder Reranker:** Top 8 chunks selected per retrieval type.
- **Final Context:** 3-5 chunks after retrieval evaluation.

### Optional Enhancements for Future

- **MMR-based Diversity:** Prevent duplication in retrieved contexts.
- **Score Fusion:** Combining vector and cross-encoder scores for balanced recall and precision.
- **Feedback Loop:** Integrating user feedback to optimize retrieval and classification nodes over time.

### Conclusion

This design provides an intelligent, adaptive, and fully LLM-driven RAG pipeline. Integrating rerankers significantly boosts retrieval precision across all data sources, optimizes the downstream generative process, and ensures robust, high-quality outputs tailored for fintech and crypto use-cases.
