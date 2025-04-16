import * as pulumi from '@pulumi/pulumi';
import { dev } from './environments/dev';

// Get the current stack
const stack = pulumi.getStack();

// Deploy the appropriate environment based on the stack
switch (stack) {
  case 'dev':
    dev();
    break;
  case 'staging':
    // TODO: Implement staging environment
    throw new Error('Staging environment not implemented yet');
  case 'production':
    // TODO: Implement production environment
    throw new Error('Production environment not implemented yet');
  default:
    throw new Error(`Unknown stack: ${stack}`);
}

// Export outputs
export const outputs = {
  stack,
  // Add more outputs as needed
};
