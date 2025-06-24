/**
 * Represents an RPC error with structured error information
 */
export type RpcError = {
  /** Unique error code identifier for programmatic error handling */
  errorCode: string;
  /** Human-readable error message describing what went wrong */
  message: string;
};

/**
 * Represents a plan entity with basic identification
 */
export type Plan = {
  /** Unique identifier for the plan */
  id: string;
  /** Display name of the plan */
  name: string;
};

/**
 * Interface defining the functions available on the RPC server
 * These functions can be called remotely by RPC clients
 */
export interface ServerFunctions {
  /**
   * Generates text based on the provided prompt
   * @param prompt - The input prompt to generate text from
   * @returns Generated text response
   */
  generateText: (prompt: string) => string;

  /**
   * Get plan
   * @param planId - The ID of the plan to get
   * @returns The plan object
   */
  getPlan: (planId: string) => Plan;
}

/**
 * Interface defining the functions available on the RPC client
 * These functions can be called by the RPC server to interact with the client
 */
export interface ClientFunctions {
  /**
   * Displays an error to the client user interface
   * @param error - The error object to display
   */
  showError: (error: Error) => void;
  /**
   * Updates the list of discovered URLs in the client
   * @param url - The newly discovered URL to add
   */
  updateDiscoveriedUrls: (url: string) => void;

  /**
   * Get browser version
   */
  getBrowserVersion: () => string;
}
