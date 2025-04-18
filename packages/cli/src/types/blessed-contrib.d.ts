declare module 'blessed-contrib' {
  import * as blessed from 'blessed';

  export interface GridOptions {
    rows: number;
    cols: number;
    screen: blessed.Widgets.Screen;
  }

  export class grid {
    constructor(options: GridOptions);
    set(row: number, col: number, rowSpan: number, colSpan: number, obj: any, opts: any): any;
  }

  export function map(options?: any): any;
  export function line(options?: any): any;
  export function bar(options?: any): any;
  export function table(options?: any): any;
  export function tree(options?: any): any;
  export function donut(options?: any): any;
  export function gauge(options?: any): any;
  export function stackedBar(options?: any): any;
  export function sparkline(options?: any): any;
  export function lcd(options?: any): any;
  export function log(options?: any): any;
  export function picture(options?: any): any;
  export function markdown(options?: any): any;
}
