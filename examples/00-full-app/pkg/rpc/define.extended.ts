import type { FrameworkClientFunctions, FrameworkServerFunctions } from "./framework.define";

/**
 * Represents a plan entity with basic identification
 */
export type Plan = {
  /** Unique identifier for the plan */
  id: string;
  /** Display name of the plan */
  name: string;
};

export type GetPlanRequest = {
  shopId: string;
  planId: string;
};

/**
 * Interface defining the functions available on the RPC server
 * These functions can be called remotely by RPC clients
 * Extends FrameworkServerFunctions to inherit framework-level functions
 */
export interface ServerFunctions extends FrameworkServerFunctions {
  /**
   * Generates text based on the provided prompt
   */
  generateText: (prompt: string) => string;

  /**
   * Get plan
   */
  getPlan: (request: GetPlanRequest) => Plan;
}

/**
 * Interface defining the functions available on the RPC client
 * These functions can be called by the RPC server to interact with the client
 * Extends FrameworkClientFunctions to inherit framework-level functions
 */
export interface ClientFunctions extends FrameworkClientFunctions {
  /**
   * Updates the list of discovered URLs in the client
   */
  updateDiscoveriedUrls: (url: string) => void;
}
