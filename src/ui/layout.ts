export const HEADER_ROWS = 1;
export const INPUT_ROWS = 3;
export const STATUS_BAR_ROWS = 1;
export const MIN_CONTENT_ROWS = 6;
export const NARROW_COLUMNS = 100;

export interface LayoutInput {
  rows: number;
  columns: number;
  interactive: boolean;
  editing: boolean;
  menuRows: number;
  bannerRows: number;
}

export interface Layout {
  contentHeight: number;
  narrow: boolean;
  showPrompt: boolean;
  showStatusBar: boolean;
}

export function computeLayout(input: LayoutInput): Layout {
  const showStatusBar = !input.editing;
  const showPrompt = input.interactive && showStatusBar;
  const chrome =
    HEADER_ROWS +
    input.bannerRows +
    (showStatusBar ? STATUS_BAR_ROWS : 0) +
    (showPrompt ? INPUT_ROWS + input.menuRows : 0);
  return {
    contentHeight: Math.max(MIN_CONTENT_ROWS, input.rows - chrome),
    narrow: input.columns < NARROW_COLUMNS,
    showPrompt,
    showStatusBar,
  };
}
