export class ThinkingIndicator {
  private interval?: NodeJS.Timeout;
  private dots = 0;

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      process.stdout.write('.');
      this.dots++;
      if (this.dots > 3) {
        process.stdout.write('\b\b\b   \b\b\b');
        this.dots = 0;
      }
    }, 500);
  }

  stop(rewritePromptText?: string) {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');
    if (rewritePromptText) process.stdout.write(rewritePromptText);
  }
} 