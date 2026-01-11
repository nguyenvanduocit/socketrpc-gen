/**
 * Example 02: Single-Level Extension - Application Definitions
 *
 * This example demonstrates extending base interfaces with application-specific functions.
 */

import type { BaseClientFunctions, BaseServerFunctions } from "./base.define";

/**
 * Product entity
 */
export type Product = {
  id: string;
  name: string;
  price: number;
};

export type CreateProductRequest = {
  name: string;
  price: number;
};

/**
 * Application-specific server functions
 * Extends BaseServerFunctions to inherit ping() and getServerTime()
 */
export interface ServerFunctions extends BaseServerFunctions {
  /**
   * Get product by ID
   */
  getProduct: (productId: string) => Product;

  /**
   * Create a new product
   */
  createProduct: (request: CreateProductRequest) => Product;

  /**
   * List all products
   */
  listProducts: () => Product[];
}

/**
 * Application-specific client functions
 * Extends BaseClientFunctions to inherit showError(), showSuccess(), and getClientInfo()
 */
export interface ClientFunctions extends BaseClientFunctions {
  /**
   * Notify client that a product was updated
   */
  onProductUpdated: (product: Product) => void;

  /**
   * Ask client to refresh their product list
   */
  refreshProducts: () => void;
}
