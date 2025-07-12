type LLMProvider = 'openai' | 'anthropic' | 'groq' | 'google' | 'cerebras';

declare const create: (args: {
    projectName?: string;
    components?: string[];
    llmProvider?: LLMProvider;
    addExample?: boolean;
    llmApiKey?: string;
    createVersionTag?: string;
    timeout?: number;
    directory?: string;
    mcpServer?: "windsurf" | "cursor" | "cursor-global";
}) => Promise<void>;

export { create };
