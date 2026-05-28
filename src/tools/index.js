/**
 * Public entry point for the Tool system.
 *
 * Example usage:
 *   import { ToolRegistry, BaseTool, CleaningIssueTool } from './tools/index.js';
 *
 * All future capability-style features (detectors, policy checkers, lookups, etc.)
 * should be implemented as classes extending BaseTool and registered via ToolRegistry.
 */
export { BaseTool } from './BaseTool.js';
export { ToolRegistry } from './ToolRegistry.js';
export { CleaningIssueTool } from './CleaningIssueTool.js';
