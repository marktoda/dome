import { simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';

// src/llm/model/mock.ts
function createMockModel({
  objectGenerationMode,
  mockText,
  spyGenerate,
  spyStream
}) {
  const mockModel = new MockLanguageModelV1({
    defaultObjectGenerationMode: objectGenerationMode,
    doGenerate: async (props) => {
      if (spyGenerate) {
        spyGenerate(props);
      }
      if (objectGenerationMode === "json") {
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 20 },
          text: JSON.stringify(mockText)
        };
      }
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20 },
        text: typeof mockText === "string" ? mockText : JSON.stringify(mockText)
      };
    },
    doStream: async (props) => {
      if (spyStream) {
        spyStream(props);
      }
      const text = typeof mockText === "string" ? mockText : JSON.stringify(mockText);
      const chunks = text.split(" ").map((word) => ({
        type: "text-delta",
        textDelta: word + " "
      }));
      return {
        stream: simulateReadableStream({
          chunks: [
            ...chunks,
            {
              type: "finish",
              finishReason: "stop",
              logprobs: void 0,
              usage: { completionTokens: 10, promptTokens: 3 }
            }
          ]
        }),
        rawCall: { rawPrompt: null, rawSettings: {} }
      };
    }
  });
  return mockModel;
}

export { createMockModel };
