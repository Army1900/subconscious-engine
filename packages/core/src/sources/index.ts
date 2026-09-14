import type { DataSource } from "../types.js";
import { cwdContextSource } from "./cwd-context.js";
import { activeEditorSource } from "./active-editor.js";
import { recentSessionsSource } from "./recent-sessions.js";
import { sessionContentSource } from "./session-content.js";
import { clipboardSource } from "./clipboard.js";
import { imageAcquisitionSource } from "./image-acquisition.js";

/** M1 首批数据源（全部 L0；DESIGN §4.2）。新增数据源不改 core 逻辑，只需再登记 */
export const DEFAULT_SOURCES: readonly DataSource[] = [
  cwdContextSource,
  activeEditorSource,
  recentSessionsSource,
  sessionContentSource,
  clipboardSource,
  imageAcquisitionSource,
];

export { cwdContextSource, activeEditorSource, recentSessionsSource, sessionContentSource, clipboardSource, imageAcquisitionSource };
