import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';
import { loadConfig, saveConfig } from '../../utils/config';

/**
 * Create the settings screen
 * @param layout The base layout elements
 * @returns The settings screen
 */
export function createSettingsScreen(layout: BaseLayoutElements): Screen {
  // Load the current config
  const config = loadConfig();

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
    content: '{center}{bold}Settings{/bold}{/center}',
    tags: true,
  });

  // Create a settings form
  const settingsForm = blessed.form({
    parent: element,
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-6',
    keys: true,
    vi: true,
    mouse: true,
    padding: {
      left: 1,
      right: 1,
    },
  });

  // API URL setting
  blessed.text({
    parent: settingsForm,
    top: 0,
    left: 0,
    content: 'API URL:',
  });

  const apiUrlInput = blessed.textbox({
    parent: settingsForm,
    top: 0,
    left: 10,
    width: '100%-12',
    height: 1,
    inputOnFocus: true,
    value: config.baseUrl || '',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // API Key setting
  blessed.text({
    parent: settingsForm,
    top: 3,
    left: 0,
    content: 'API Key:',
  });

  const apiKeyInput = blessed.textbox({
    parent: settingsForm,
    top: 3,
    left: 10,
    width: '100%-12',
    height: 1,
    inputOnFocus: true,
    value: config.apiKey || '',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    censor: true,
  });

  // Environment setting
  blessed.text({
    parent: settingsForm,
    top: 6,
    left: 0,
    content: 'Environment:',
  });

  const environmentInput = blessed.radioset({
    parent: settingsForm,
    top: 6,
    left: 12,
    width: '100%-14',
    height: 3,
  });

  blessed.radiobutton({
    parent: environmentInput,
    top: 0,
    left: 0,
    content: 'Development',
    checked: config.environment === 'development',
  });

  blessed.radiobutton({
    parent: environmentInput,
    top: 0,
    left: 15,
    content: 'Production',
    checked: config.environment === 'production',
  });

  // Theme setting
  blessed.text({
    parent: settingsForm,
    top: 10,
    left: 0,
    content: 'Theme:',
  });

  const themeInput = blessed.radioset({
    parent: settingsForm,
    top: 10,
    left: 12,
    width: '100%-14',
    height: 3,
  });

  blessed.radiobutton({
    parent: themeInput,
    top: 0,
    left: 0,
    content: 'Light',
    checked: config.theme === 'light',
  });

  blessed.radiobutton({
    parent: themeInput,
    top: 0,
    left: 15,
    content: 'Dark',
    checked: config.theme === 'dark',
  });

  // Save button
  const saveButton = blessed.button({
    parent: settingsForm,
    bottom: 0,
    left: 'center',
    width: 20,
    height: 3,
    content: 'Save Settings',
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

  // Create a footer with commands
  const footerBox = blessed.box({
    parent: element,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{bold}Commands:{/bold} [Tab] Navigate Fields | [Enter] Save | [Esc] Back to Menu',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Handle save button
  saveButton.on('press', () => {
    // Get the selected environment
    let environment: 'development' | 'production' = 'development';
    if ((environmentInput.children[1] as any).checked) {
      environment = 'production';
    }

    // Get the selected theme
    let theme: 'light' | 'dark' = 'light';
    if ((themeInput.children[1] as any).checked) {
      theme = 'dark';
    }

    // Update the config
    const newConfig = {
      ...config,
      baseUrl: apiUrlInput.getValue(),
      apiKey: apiKeyInput.getValue(),
      environment,
      theme,
    };

    // Save the config
    saveConfig(newConfig);

    // Show a success message
    layout.statusBar.setContent(
      ` {bold}Status:{/bold} Settings saved successfully | Press {bold}q{/bold} to quit | {bold}?{/bold} for help`,
    );
    layout.screen.render();
  });

  // Handle escape key to return to sidebar
  element.key('escape', () => {
    layout.sidebar.focus();
  });

  return {
    id: 'settings',
    title: 'Settings',
    element,
    onFocus: () => {
      // Focus the first input when the settings screen is shown
      apiUrlInput.focus();
    },
  };
}
