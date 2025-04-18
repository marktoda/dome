import blessed from 'blessed';
import { BaseLayoutElements } from './layouts/BaseLayout';

/**
 * Interface for a screen in the TUI
 */
export interface Screen {
  id: string;
  title: string;
  element: blessed.Widgets.BoxElement;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Screen manager to handle navigation between screens
 */
export class ScreenManager {
  private layout: BaseLayoutElements;
  private screens: Screen[] = [];
  private activeScreenIndex: number = -1;

  constructor(layout: BaseLayoutElements) {
    this.layout = layout;

    // Set up sidebar navigation
    this.layout.sidebar.on('select', (item: any, index: number) => {
      this.showScreen(index);
    });

    // Global key bindings
    this.layout.screen.key('?', () => {
      const helpIndex = this.screens.findIndex(screen => screen.id === 'help');
      if (helpIndex !== -1) {
        this.showScreen(helpIndex);
        this.layout.sidebar.select(helpIndex);
      }
    });

    this.layout.screen.key('h', () => {
      const dashboardIndex = this.screens.findIndex(screen => screen.id === 'dashboard');
      if (dashboardIndex !== -1) {
        this.showScreen(dashboardIndex);
        this.layout.sidebar.select(dashboardIndex);
      }
    });
  }

  /**
   * Register a screen with the manager
   * @param screen The screen to register
   */
  registerScreen(screen: Screen): void {
    this.screens.push(screen);
    screen.element.hide();
  }

  /**
   * Show a specific screen
   * @param index The index of the screen to show
   */
  showScreen(index: number): void {
    if (index < 0 || index >= this.screens.length) {
      return;
    }

    // Call onBlur for the active screen
    if (this.activeScreenIndex !== -1 && this.screens[this.activeScreenIndex].onBlur) {
      this.screens[this.activeScreenIndex].onBlur!();
    }

    // Hide all screens
    this.screens.forEach(screen => screen.element.hide());

    // Show the selected screen
    this.screens[index].element.show();

    // Call onFocus for the new active screen
    if (this.screens[index].onFocus) {
      this.screens[index].onFocus();
    }

    // Update status bar
    this.layout.statusBar.setContent(
      ` {bold}Status:{/bold} Viewing ${this.screens[index].title} | Press {bold}q{/bold} to quit | {bold}?{/bold} for help`,
    );

    this.activeScreenIndex = index;
    this.layout.screen.render();
  }

  /**
   * Initialize the screen manager
   */
  init(): void {
    if (this.screens.length > 0) {
      this.showScreen(0);
      this.layout.sidebar.select(0);
    }
    this.layout.screen.render();
  }
}
