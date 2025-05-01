/**
 * Notion Test Fixtures
 * 
 * This file contains shared mock data and fixtures for Notion tests.
 */

import { NotionPage, NotionBlock } from '../../../src/providers/notion/client';

/**
 * Mock Notion Pages
 */
export const mockPages: NotionPage[] = [
  {
    id: 'page-123',
    title: 'Test Page',
    url: 'https://notion.so/test-page-123',
    last_edited_time: '2023-04-30T12:00:00Z',
    parent: {
      type: 'workspace',
      workspace: true
    },
    properties: {
      title: {
        type: 'title',
        title: [
          { plain_text: 'Test Page' }
        ]
      }
    }
  },
  {
    id: 'page-456',
    title: 'Test Page with Parent',
    url: 'https://notion.so/test-page-456',
    last_edited_time: '2023-04-29T12:00:00Z',
    parent: {
      type: 'page_id',
      page_id: 'parent-789'
    },
    properties: {
      Name: {
        type: 'title',
        title: [
          { plain_text: 'Test Page with Parent' }
        ]
      }
    }
  },
  {
    id: 'db-entry-789',
    title: 'Database Entry',
    url: 'https://notion.so/db-entry-789',
    last_edited_time: '2023-04-28T12:00:00Z',
    parent: {
      type: 'database_id',
      database_id: 'db-123'
    },
    properties: {
      Name: {
        type: 'title',
        title: [
          { plain_text: 'Database Entry' }
        ]
      },
      Status: {
        type: 'select',
        select: {
          name: 'Complete'
        }
      },
      Priority: {
        type: 'number',
        number: 1
      }
    }
  }
];

/**
 * Mock Notion Blocks
 */
export const mockBlocks: NotionBlock[] = [
  {
    id: 'block-1',
    type: 'paragraph',
    has_children: false,
    paragraph: {
      rich_text: [
        { 
          plain_text: 'This is a paragraph with ',
          annotations: { 
            bold: false,
            italic: false,
            strikethrough: false,
            code: false
          }
        },
        {
          plain_text: 'bold',
          annotations: {
            bold: true,
            italic: false,
            strikethrough: false,
            code: false
          }
        },
        {
          plain_text: ' and ',
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            code: false
          }
        },
        {
          plain_text: 'italic',
          annotations: {
            bold: false,
            italic: true,
            strikethrough: false,
            code: false
          }
        },
        {
          plain_text: ' text.',
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            code: false
          }
        }
      ]
    }
  },
  {
    id: 'block-2',
    type: 'heading_1',
    has_children: false,
    heading_1: {
      rich_text: [
        { plain_text: 'Heading 1' }
      ]
    }
  },
  {
    id: 'block-3',
    type: 'heading_2',
    has_children: false,
    heading_2: {
      rich_text: [
        { plain_text: 'Heading 2' }
      ]
    }
  },
  {
    id: 'block-4',
    type: 'heading_3',
    has_children: false,
    heading_3: {
      rich_text: [
        { plain_text: 'Heading 3' }
      ]
    }
  },
  {
    id: 'block-5',
    type: 'bulleted_list_item',
    has_children: false,
    bulleted_list_item: {
      rich_text: [
        { plain_text: 'Bullet point 1' }
      ]
    }
  },
  {
    id: 'block-6',
    type: 'numbered_list_item',
    has_children: false,
    numbered_list_item: {
      rich_text: [
        { plain_text: 'Numbered point 1' }
      ]
    }
  },
  {
    id: 'block-7',
    type: 'to_do',
    has_children: false,
    to_do: {
      rich_text: [
        { plain_text: 'Todo item (unchecked)' }
      ],
      checked: false
    }
  },
  {
    id: 'block-8',
    type: 'to_do',
    has_children: false,
    to_do: {
      rich_text: [
        { plain_text: 'Todo item (checked)' }
      ],
      checked: true
    }
  },
  {
    id: 'block-9',
    type: 'code',
    has_children: false,
    code: {
      rich_text: [
        { plain_text: 'const x = 1;\nconsole.log(x);' }
      ],
      language: 'javascript'
    }
  },
  {
    id: 'block-10',
    type: 'quote',
    has_children: false,
    quote: {
      rich_text: [
        { plain_text: 'This is a quote' }
      ]
    }
  },
  {
    id: 'block-11',
    type: 'divider',
    has_children: false
  },
  {
    id: 'block-12',
    type: 'callout',
    has_children: false,
    callout: {
      rich_text: [
        { plain_text: 'This is a callout' }
      ],
      icon: {
        emoji: '💡'
      }
    }
  }
];

/**
 * Mock Database
 */
export const mockDatabase = {
  id: 'db-123',
  title: [{ plain_text: 'Test Database' }],
  url: 'https://notion.so/db-123',
  last_edited_time: '2023-04-30T12:00:00Z',
  properties: {
    Name: { type: 'title', name: 'Name' },
    Tags: { type: 'multi_select', name: 'Tags' },
    Status: { type: 'select', name: 'Status' },
    Deadline: { type: 'date', name: 'Deadline' },
    Priority: { type: 'number', name: 'Priority' }
  }
};

/**
 * Mock Database Rows (Pages in the database)
 */
export const mockDatabaseRows = [
  {
    id: 'row-1',
    properties: {
      Name: { 
        type: 'title', 
        title: [{ plain_text: 'Task 1' }] 
      },
      Tags: { 
        type: 'multi_select', 
        multi_select: [
          { name: 'Important' },
          { name: 'Frontend' }
        ] 
      },
      Status: { 
        type: 'select', 
        select: { name: 'In Progress' } 
      },
      Deadline: { 
        type: 'date', 
        date: { start: '2023-05-15' } 
      },
      Priority: { 
        type: 'number', 
        number: 1 
      }
    }
  },
  {
    id: 'row-2',
    properties: {
      Name: { 
        type: 'title', 
        title: [{ plain_text: 'Task 2' }] 
      },
      Tags: { 
        type: 'multi_select', 
        multi_select: [
          { name: 'Backend' }
        ] 
      },
      Status: { 
        type: 'select', 
        select: { name: 'To Do' } 
      },
      Deadline: { 
        type: 'date', 
        date: { start: '2023-05-30' } 
      },
      Priority: { 
        type: 'number', 
        number: 2 
      }
    }
  },
  {
    id: 'row-3',
    properties: {
      Name: { 
        type: 'title', 
        title: [{ plain_text: 'Task 3' }] 
      },
      Tags: { 
        type: 'multi_select', 
        multi_select: [
          { name: 'Documentation' },
          { name: 'Important' }
        ] 
      },
      Status: { 
        type: 'select', 
        select: { name: 'Done' } 
      },
      Deadline: { 
        type: 'date', 
        date: { start: '2023-04-20', end: '2023-04-25' } 
      },
      Priority: { 
        type: 'number', 
        number: 1 
      }
    }
  }
];

/**
 * Mock OAuth Token Response
 */
export const mockOAuthTokenResponse = {
  access_token: 'test-access-token',
  workspace_id: 'workspace-123',
  workspace_name: 'Test Workspace',
  workspace_icon: 'https://notion.so/icons/workspace.png',
  bot_id: 'bot-123',
  owner: {
    type: 'user',
    user: {
      id: 'user-123',
      name: 'Test User',
      avatar_url: 'https://notion.so/avatars/user-123.png'
    }
  }
};

/**
 * Mock Successful API Responses
 */
export const mockApiResponses = {
  search: {
    results: mockPages,
    next_cursor: null,
    has_more: false,
    type: 'page',
    page: {}
  },
  getPage: mockPages[0],
  getBlocks: {
    results: mockBlocks,
    next_cursor: null,
    has_more: false
  },
  getUsers: {
    results: [
      {
        id: 'user-123',
        name: 'Test User',
        avatar_url: 'https://notion.so/avatars/user-123.png',
        type: 'person'
      },
      {
        id: 'bot-123',
        name: 'Integration Bot',
        avatar_url: 'https://notion.so/avatars/bot-123.png',
        type: 'bot'
      }
    ],
    next_cursor: null,
    has_more: false
  },
  getDatabase: mockDatabase
};