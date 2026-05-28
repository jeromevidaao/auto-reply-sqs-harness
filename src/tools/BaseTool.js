/**
 * BaseTool
 *
 * A lightweight base class for all tools the GuestMessagingAgent can use.
 * This gives us a consistent interface for future tool-calling capabilities.
 */
export class BaseTool {
  constructor({ name, description } = {}) {
    if (!name) {
      throw new Error('Tool must have a name');
    }
    this.name = name;
    this.description = description || '';
  }

  /**
   * Execute the tool.
   * Subclasses must implement this method.
   *
   * @param {any} input
   * @param {object} [context] - Optional context (e.g. reservation info, guest message, etc.)
   * @returns {Promise<any>}
   */
  async execute(input, context = {}) {
    throw new Error(`Tool "${this.name}" must implement the execute() method`);
  }

  /**
   * Optional: Return a JSON schema for the tool's input (useful later for tool calling / validation).
   */
  get inputSchema() {
    return null;
  }
}
