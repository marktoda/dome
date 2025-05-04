/**
 * Example of how to use the thinking event handler
 * This demonstrates a complete implementation for properly handling thinking content
 * in client applications to prevent content filter errors.
 */

import {
  createThinkingEventHandler,
  EventType,
  ThinkingEventHandler,
  ChatClient,
} from '../src/client';

// Create a mock DOM element for the example
const mockDomElements = {
  responseContainer: document.createElement('div'),
  thinkingContainer: document.createElement('div'),
  sourcesList: document.createElement('ul'),
  workflowStep: document.createElement('div'),
};

// Initialize the thinking event handler
function initializeThinkingEventClient(streamUrl: string) {
  console.log('Initializing thinking event client...');

  // Create the handler
  const eventHandler = createThinkingEventHandler();

  // Create EventSource for SSE connection
  const eventSource = new EventSource(streamUrl);

  // Set up error handling
  eventSource.onerror = error => {
    console.error('EventSource error:', error);
    eventSource.close();
  };

  // Set up event listeners for specific event types

  // Handle text events (normal chat responses)
  eventSource.addEventListener('text', event => {
    try {
      const data = JSON.parse(event.data);
      mockDomElements.responseContainer.textContent = data.text;
    } catch (error) {
      console.error('Error parsing text event:', error);
    }
  });

  // Handle thinking events (content that might trigger filters)
  eventSource.addEventListener('thinking', event => {
    try {
      // Parse the event using our helper
      const thinkingEvent = ThinkingEventHandler.parseSSEMessage('thinking', event.data);
      if (thinkingEvent) {
        // Process the event through our handler (applies any additional processing)
        eventHandler.processEvent(thinkingEvent);
      }
    } catch (error) {
      console.error('Error processing thinking event:', error);
    }
  });

  // Handle sources events
  eventSource.addEventListener('sources', event => {
    try {
      const sources = JSON.parse(event.data);
      // Clear previous sources
      mockDomElements.sourcesList.innerHTML = '';

      // Add each source to the list
      sources.forEach((source: any) => {
        const li = document.createElement('li');
        li.textContent = `${source.title} (${source.source})`;
        mockDomElements.sourcesList.appendChild(li);
      });
    } catch (error) {
      console.error('Error processing sources event:', error);
    }
  });

  // Handle workflow step events
  eventSource.addEventListener('workflow_step', event => {
    try {
      const data = JSON.parse(event.data);
      mockDomElements.workflowStep.textContent = `Current step: ${data.step}`;
    } catch (error) {
      console.error('Error processing workflow step event:', error);
    }
  });

  // Handle end event to close the connection
  eventSource.addEventListener('end', () => {
    console.log('Chat session completed');
    eventSource.close();
  });

  // Register listeners with our thinking event handler

  // This listener will be called whenever thinking content is received
  eventHandler.addEventListener(EventType.Thinking, data => {
    if (data && data.thinking) {
      // Display thinking content in a dedicated container
      mockDomElements.thinkingContainer.textContent = data.thinking;
      // You might want to style this differently or make it collapsible
      mockDomElements.thinkingContainer.style.backgroundColor = '#f0f0f0';
      mockDomElements.thinkingContainer.style.fontFamily = 'monospace';
      mockDomElements.thinkingContainer.style.padding = '10px';
      mockDomElements.thinkingContainer.style.marginBottom = '20px';
    }
  });

  return {
    eventSource,
    eventHandler,
    closeConnection: () => {
      eventSource.close();
      console.log('Connection closed');
    },
  };
}

/**
 * Example usage of the thinking event client
 */
async function main() {
  // In a real application, you would:
  // 1. Create a chat client
  // const chatClient = new ChatClient(yourWorkerBinding);

  // 2. Start a chat session
  // const response = await chatClient.streamResponse({
  //   userId: 'user-123',
  //   messages: [{ role: 'user', content: 'How does UniswapX work?' }],
  //   options: { enhanceWithContext: true }
  // });

  // 3. Get the URL for the streaming response
  // const streamUrl = 'https://your-service.com/chat/stream?session=123';

  // For this example, we'll use a mock URL
  const mockStreamUrl = 'https://example.com/chat/stream';

  // Initialize the client
  const client = initializeThinkingEventClient(mockStreamUrl);

  // In a real application, you would:
  // 1. Add the containers to your DOM
  // document.body.appendChild(mockDomElements.responseContainer);
  // document.body.appendChild(mockDomElements.thinkingContainer);
  // document.body.appendChild(mockDomElements.sourcesList);
  // document.body.appendChild(mockDomElements.workflowStep);

  console.log('Client initialized, waiting for events...');

  // When you're done with the connection
  // client.closeConnection();
}

// In a real application, you would call main()
// main().catch(console.error);

// Export for testing/example purposes
export { initializeThinkingEventClient, mockDomElements };
