import { Env, GitHubPushEvent, GitHubInstallationEvent, GitHubInstallationRepositoriesEvent } from '../types';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { WebhookService } from './service';

/**
 * Verify GitHub webhook signature
 * @param payload Webhook payload
 * @param signature X-Hub-Signature-256 header
 * @param secret Webhook secret
 * @returns Whether the signature is valid
 */
export async function verifyGitHubWebhook(
  payload: any,
  signature: string,
  secret: string
): Promise<boolean> {
  // Convert the payload to a string
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  
  // Create a message encoder
  const encoder = new TextEncoder();
  
  // Create the expected signature
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const expectedSignature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payloadString)
  );
  
  // Convert the expected signature to a hex string
  const expectedSignatureHex = Array.from(new Uint8Array(expectedSignature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Compare the signatures
  const providedSignature = signature.replace('sha256=', '');
  return providedSignature === expectedSignatureHex;
}

/**
 * Handle GitHub webhook requests
 * @param request Incoming request
 * @param env Environment variables and bindings
 * @returns Response
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const startTime = performance.now();
  
  try {
    // Get the event type and delivery ID
    const eventType = request.headers.get('x-github-event');
    const deliveryId = request.headers.get('x-github-delivery');
    
    if (!eventType) {
      return new Response('Missing X-GitHub-Event header', { status: 400 });
    }
    
    logger().info({ eventType, deliveryId }, 'Received GitHub webhook');
    metrics.counter('webhook.received', 1, { event_type: eventType });
    
    // Clone the request to read the body
    const clonedRequest = request.clone();
    let payload: any;
    
    try {
      payload = await clonedRequest.json();
    } catch (error) {
      logger().warn({ eventType, deliveryId }, 'Invalid JSON payload');
      return new Response('Invalid JSON payload', { status: 400 });
    }
    
    // Verify the webhook signature
    const signature = request.headers.get('x-hub-signature-256');
    if (!signature) {
      return new Response('Missing X-Hub-Signature-256 header', { status: 400 });
    }
    
    const isValid = await verifyGitHubWebhook(
      payload,
      signature,
      env.GITHUB_WEBHOOK_SECRET
    );
    
    if (!isValid) {
      logger().warn({ eventType, deliveryId }, 'Invalid webhook signature');
      metrics.counter('webhook.invalid_signature', 1, { event_type: eventType });
      return new Response('Invalid signature', { status: 401 });
    }
    
    // Create webhook service
    const webhookService = new WebhookService(env);
    
    // Process the webhook based on the event type
    let result: boolean;
    
    switch (eventType) {
      case 'ping':
        logger().info({ hook_id: payload.hook_id, zen: payload.zen }, 'Received ping event');
        metrics.counter('webhook.ping', 1);
        return new Response('Pong!');
        
      case 'push':
        result = await webhookService.processPushEvent(payload as GitHubPushEvent);
        break;
        
      case 'installation':
        result = await webhookService.processInstallationEvent(payload as GitHubInstallationEvent);
        break;
        
      case 'installation_repositories':
        result = await webhookService.processInstallationRepositoriesEvent(
          payload as GitHubInstallationRepositoriesEvent
        );
        break;
        
      default:
        logger().info({ eventType }, 'Ignoring unsupported event type');
        return new Response('Event type not supported', { status: 202 });
    }
    
    if (result) {
      return new Response('OK');
    } else {
      return new Response('Webhook processed but no action taken', { status: 202 });
    }
  } catch (error) {
    logError(error as Error, 'Error processing webhook');
    metrics.counter('webhook.error', 1);
    return new Response('Internal server error', { status: 500 });
  } finally {
    metrics.timing('webhook.process_time_ms', performance.now() - startTime);
  }
}

// Keep the existing verifyGitHubWebhook function