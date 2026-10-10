/** sent by the popup to capture a tab with a chosen title and author */
export interface TitleRequest {
  tabId: number;
  title?: string;
  author?: string;
}
