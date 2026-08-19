/** Label applied to mark a work item as archived (Plane's native archive is
 *  restricted to completed/cancelled items, so we use a label convention). */
export const ARCHIVE_LABEL = "archived";

/** `external_source` stamped on every planestories-created work item — the marker
 *  that identifies items (and `::ac<n>` criterion children) that we OWN. Lives here,
 *  not in importer.ts, so value modules like board-story.ts can consult it without a
 *  circular import back through the importer. */
export const EXTERNAL_SOURCE = "planestories";

/** Tool version recorded in snapshots/journals. Keep in sync with package.json
 *  and the program.version() call in cli/index.ts. */
export const TOOL_VERSION = "0.5.0";
