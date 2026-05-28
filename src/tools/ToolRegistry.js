/**
 * ToolRegistry
 *
 * A simple registry to hold and retrieve tools for the GuestMessagingAgent.
 * Keeps the agent decoupled from specific tool implementations.
 */
export class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  /**
   * Register a tool instance.
   * @param {BaseTool} tool
   */
  register(tool) {
    if (!tool || !tool.name) {
      throw new Error('Invalid tool: must have a name');
    }
    this._tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name.
   */
  get(name) {
    return this._tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getAll() {
    return Array.from(this._tools.values());
  }

  /**
   * Check if a tool exists.
   */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * Remove a tool.
   */
  remove(name) {
    this._tools.delete(name);
  }

  /**
   * Clear all tools.
   */
  clear() {
    this._tools.clear();
  }
}
