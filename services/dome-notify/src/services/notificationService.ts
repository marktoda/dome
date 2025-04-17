/**
 * Notification service for sending notifications via different channels
 */

/**
 * Notification channel interface
 */
export interface NotificationChannel {
  send(notification: Notification): Promise<void>;
}

/**
 * Notification data interface
 */
export interface Notification {
  userId: string;
  title: string;
  message: string;
  priority?: 'low' | 'medium' | 'high';
  metadata?: Record<string, any>;
}

/**
 * Email notification channel using MailChannels
 */
export class EmailNotificationChannel implements NotificationChannel {
  private fromEmail: string;
  private fromName: string;

  constructor(fromEmail: string, fromName: string) {
    this.fromEmail = fromEmail;
    this.fromName = fromName;
  }

  /**
   * Send an email notification
   * @param notification The notification to send
   */
  async send(notification: Notification): Promise<void> {
    // Get user email from metadata or fetch from database
    const userEmail = notification.metadata?.email || 'user@example.com';
    
    // Prepare email content
    const emailContent = {
      personalizations: [
        {
          to: [{ email: userEmail }],
          subject: notification.title,
        },
      ],
      from: {
        email: this.fromEmail,
        name: this.fromName,
      },
      content: [
        {
          type: 'text/plain',
          value: notification.message,
        },
        {
          type: 'text/html',
          value: `<html><body><h1>${notification.title}</h1><p>${notification.message}</p></body></html>`,
        },
      ],
    };

    try {
      // Send email using MailChannels API
      const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(emailContent),
      });

      if (!response.ok) {
        throw new Error(`Failed to send email: ${response.status} ${response.statusText}`);
      }

      console.log(`Email notification sent to ${userEmail}`);
    } catch (error) {
      console.error('Error sending email notification:', error);
      throw error;
    }
  }
}

/**
 * Slack notification channel
 */
export class SlackNotificationChannel implements NotificationChannel {
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  /**
   * Send a Slack notification
   * @param notification The notification to send
   */
  async send(notification: Notification): Promise<void> {
    if (!this.webhookUrl) {
      console.warn('Slack webhook URL not configured, skipping notification');
      return;
    }

    // Prepare Slack message
    const slackMessage = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: notification.title,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: notification.message,
          },
        },
      ],
    };

    try {
      // Send message to Slack webhook
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(slackMessage),
      });

      if (!response.ok) {
        throw new Error(`Failed to send Slack notification: ${response.status} ${response.statusText}`);
      }

      console.log('Slack notification sent');
    } catch (error) {
      console.error('Error sending Slack notification:', error);
      throw error;
    }
  }
}

/**
 * Notification service that manages multiple notification channels
 */
export class NotificationService {
  private channels: NotificationChannel[] = [];

  /**
   * Add a notification channel
   * @param channel The notification channel to add
   */
  addChannel(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  /**
   * Send a notification through all configured channels
   * @param notification The notification to send
   */
  async sendNotification(notification: Notification): Promise<void> {
    if (this.channels.length === 0) {
      throw new Error('No notification channels configured');
    }

    const errors: Error[] = [];

    // Try to send through each channel
    for (const channel of this.channels) {
      try {
        await channel.send(notification);
      } catch (error) {
        errors.push(error as Error);
      }
    }

    // If all channels failed, throw an error
    if (errors.length === this.channels.length) {
      throw new Error(`All notification channels failed: ${errors.map(e => e.message).join(', ')}`);
    }
  }
}