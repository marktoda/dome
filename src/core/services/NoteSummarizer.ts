import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

export class NoteSummarizer {
  constructor(private readonly opts: { model?: string; temperature?: number } = {}) {}

  async summarize(input: {
    path: string;
    title: string;
    content: string;
    frontmatter?: Record<string, unknown>;
  }): Promise<string> {
    const modelName = this.opts.model ?? 'gpt-4o-mini';

    const prompt = [
      `Summarize the following markdown note in 1-2 sentences.`,
      `Keep it concise and factual. Avoid bullet points and markdown.`,
      `Title: ${input.title}`,
      `Frontmatter: ${JSON.stringify(input.frontmatter ?? {})}`,
      `---`,
      input.content,
    ].join('\n');

    try {
      const { text } = await generateText({
        model: openai(modelName),
        temperature: this.opts.temperature ?? 0.2,
        maxTokens: 180,
        prompt,
      });

      const summary = text.trim().replace(/\s+/g, ' ');
      return summary || 'Summary unavailable';
    } catch (err) {
      return 'Summary unavailable';
    }
  }
}