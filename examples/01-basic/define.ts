/**
 * Example 01: Basic RPC Interface Definitions
 *
 * This example demonstrates the simplest use case with no interface extension.
 * Just define ClientFunctions and ServerFunctions interfaces with your RPC methods.
 */

/**
 * User entity
 */
export type User = {
  id: string;
  name: string;
  email: string;
};

/**
 * Interface defining functions that the SERVER provides
 * Clients can call these functions remotely
 */
export interface ServerFunctions {
  /**
   * Get user by ID
   */
  getUser: (userId: string) => User;

  /**
   * Create a new user
   */
  createUser: (name: string, email: string) => User;

  /**
   * Delete a user (fire-and-forget, no response expected)
   */
  deleteUser: (userId: string) => void;
}

/**
 * Interface defining functions that the CLIENT provides
 * Server can call these functions to push updates to the client
 */
export interface ClientFunctions {
  /**
   * Notify client of a new message
   */
  onMessage: (message: string) => void;

  /**
   * Request confirmation from client
   */
  requestConfirmation: (prompt: string) => boolean;
}
