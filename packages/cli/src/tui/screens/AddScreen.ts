import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';
import { addContent } from '../../utils/api';
import fs from 'fs';
import path from 'path';

/**
 * Create the add screen
 * @param layout The base layout elements
 * @returns The add screen
 */
export function createAddScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
  });

  // Create a header
  const headerBox = blessed.box({
    parent: element,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Add Content{/bold}{/center}',
    tags: true,
  });

  // Create a form for adding content
  const addForm = blessed.form({
    parent: element,
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-6',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // Add a content type selector
  blessed.text({
    parent: addForm,
    top: 1,
    left: 2,
    content: 'Content Type:',
  });

  const contentTypeRadio = blessed.radioset({
    parent: addForm,
    top: 2,
    left: 2,
    width: '100%-4',
    height: 3,
  });

  blessed.radiobutton({
    parent: contentTypeRadio,
    top: 0,
    left: 0,
    content: 'Text',
    checked: true,
  });

  blessed.radiobutton({
    parent: contentTypeRadio,
    top: 0,
    left: 15,
    content: 'File Path',
  });

  blessed.radiobutton({
    parent: contentTypeRadio,
    top: 0,
    left: 30,
    content: 'URL',
  });

  // Add a content input
  blessed.text({
    parent: addForm,
    top: 5,
    left: 2,
    content: 'Content:',
  });

  const contentInput = blessed.textarea({
    parent: addForm,
    top: 6,
    left: 2,
    width: '100%-4',
    height: 10,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
      focus: {
        border: {
          fg: 'green',
        },
      },
    },
  });

  // Add a file path input (initially hidden)
  const filePathInput = blessed.textbox({
    parent: addForm,
    top: 6,
    left: 2,
    width: '100%-4',
    height: 3,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
      focus: {
        border: {
          fg: 'green',
        },
      },
    },
    hidden: true,
  });

  // Add a URL input (initially hidden)
  const urlInput = blessed.textbox({
    parent: addForm,
    top: 6,
    left: 2,
    width: '100%-4',
    height: 3,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
      focus: {
        border: {
          fg: 'green',
        },
      },
    },
    hidden: true,
  });

  // Add tags input
  blessed.text({
    parent: addForm,
    top: 17,
    left: 2,
    content: 'Tags (comma separated):',
  });

  const tagsInput = blessed.textbox({
    parent: addForm,
    top: 18,
    left: 2,
    width: '100%-4',
    height: 3,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
      focus: {
        border: {
          fg: 'green',
        },
      },
    },
  });

  // Add submit and cancel buttons
  const submitButton = blessed.button({
    parent: addForm,
    bottom: 2,
    left: '25%',
    width: 10,
    height: 3,
    content: 'Submit',
    align: 'center',
    valign: 'middle',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'green',
      },
      focus: {
        bg: 'green',
        fg: 'black',
      },
    },
    mouse: true,
  });

  const cancelButton = blessed.button({
    parent: addForm,
    bottom: 2,
    right: '25%',
    width: 10,
    height: 3,
    content: 'Cancel',
    align: 'center',
    valign: 'middle',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'red',
      },
      focus: {
        bg: 'red',
        fg: 'black',
      },
    },
    mouse: true,
  });

  // Create a status message box
  const statusBox = blessed.box({
    parent: element,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // Create a loading indicator
  const loadingIndicator = blessed.loading({
    parent: element,
    top: 'center',
    left: 'center',
    width: 20,
    height: 3,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
    hidden: true,
  });

  // Handle radio button selection
  contentTypeRadio.on('select', (radio: any) => {
    const selectedType = radio.content;

    // Hide all input fields
    contentInput.hide();
    filePathInput.hide();
    urlInput.hide();

    // Show the appropriate input field based on selection
    if (selectedType === 'Text') {
      contentInput.show();
      contentInput.focus();
    } else if (selectedType === 'File Path') {
      filePathInput.show();
      filePathInput.focus();
    } else if (selectedType === 'URL') {
      urlInput.show();
      urlInput.focus();
    }

    layout.screen.render();
  });

  // Handle form submission
  submitButton.on('press', async () => {
    try {
      // Get the selected content type
      let selectedType = 'Text';
      contentTypeRadio.children.forEach((child: any) => {
        if (child.checked) {
          selectedType = child.content;
        }
      });

      let content = '';

      // Show loading indicator
      loadingIndicator.load('Adding content...');
      loadingIndicator.show();
      layout.screen.render();

      // Get content based on the selected type
      if (selectedType === 'Text') {
        content = contentInput.getValue();
      } else if (selectedType === 'File Path') {
        const filePath = filePathInput.getValue().trim();

        // Validate file path
        if (!fs.existsSync(filePath)) {
          statusBox.setContent('{red-fg}Error: File not found{/red-fg}');
          loadingIndicator.stop();
          loadingIndicator.hide();
          layout.screen.render();
          return;
        }

        // Read file content
        content = fs.readFileSync(filePath, 'utf-8');
      } else if (selectedType === 'URL') {
        // For URLs, we'll just pass the URL directly to the API
        content = urlInput.getValue().trim();

        // Validate URL
        if (!content.startsWith('http://') && !content.startsWith('https://')) {
          statusBox.setContent(
            '{red-fg}Error: Invalid URL. Must start with http:// or https://{/red-fg}',
          );
          loadingIndicator.stop();
          loadingIndicator.hide();
          layout.screen.render();
          return;
        }
      }

      // Validate content
      if (!content.trim()) {
        statusBox.setContent('{red-fg}Error: Content cannot be empty{/red-fg}');
        loadingIndicator.stop();
        loadingIndicator.hide();
        layout.screen.render();
        return;
      }

      // Get tags
      const tags = tagsInput.getValue().trim()
        ? tagsInput
            .getValue()
            .split(',')
            .map(tag => tag.trim())
        : [];

      // Add content using the API
      const response = await addContent(content);

      // Hide loading indicator
      loadingIndicator.stop();
      loadingIndicator.hide();

      // Show success message
      statusBox.setContent('{green-fg}Content added successfully!{/green-fg}');

      // Clear form
      contentInput.setValue('');
      filePathInput.setValue('');
      urlInput.setValue('');
      tagsInput.setValue('');

      layout.screen.render();
    } catch (err) {
      // Hide loading indicator
      loadingIndicator.stop();
      loadingIndicator.hide();

      // Show error message
      statusBox.setContent(
        `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      layout.screen.render();
    }
  });

  // Handle cancel button
  cancelButton.on('press', () => {
    // Clear form
    contentInput.setValue('');
    filePathInput.setValue('');
    urlInput.setValue('');
    tagsInput.setValue('');
    statusBox.setContent('');

    // Return to sidebar
    layout.sidebar.focus();
    layout.screen.render();
  });

  // Handle escape key to return to sidebar
  element.key('escape', () => {
    layout.sidebar.focus();
  });

  return {
    id: 'add',
    title: 'Add Content',
    element,
    onFocus: () => {
      // Focus the content input when the screen is shown
      contentInput.focus();
      statusBox.setContent('');
      layout.screen.render();
    },
  };
}
