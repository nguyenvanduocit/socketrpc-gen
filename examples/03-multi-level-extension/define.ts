/**
 * Example 03: Multi-Level Extension - Application Layer
 *
 * This is the top level - application-specific functionality
 * Inheritance chain: Framework -> Platform -> Application
 */

import type { PlatformClientFunctions, PlatformServerFunctions } from "./platform.define";

export type Order = {
  id: string;
  userId: string;
  items: string[];
  total: number;
  status: "pending" | "processing" | "completed" | "cancelled";
};

export type CreateOrderRequest = {
  items: string[];
};

export type OrderStatusUpdate = {
  orderId: string;
  status: Order["status"];
  message?: string;
};

/**
 * Application-level server functions
 *
 * Inheritance chain:
 * - FrameworkServerFunctions: healthCheck()
 * - PlatformServerFunctions: login(), getCurrentUser(), logout()
 * - ServerFunctions: getOrder(), createOrder(), cancelOrder()
 */
export interface ServerFunctions extends PlatformServerFunctions {
  /**
   * Get order by ID
   */
  getOrder: (orderId: string) => Order;

  /**
   * Create a new order
   */
  createOrder: (request: CreateOrderRequest) => Order;

  /**
   * Cancel an order
   */
  cancelOrder: (orderId: string) => Order;

  /**
   * List user's orders
   */
  listOrders: (userId: string) => Order[];
}

/**
 * Application-level client functions
 *
 * Inheritance chain:
 * - FrameworkClientFunctions: log(), getVersion()
 * - PlatformClientFunctions: showNotification(), requestAuth()
 * - ClientFunctions: onOrderStatusChanged(), refreshOrderList()
 */
export interface ClientFunctions extends PlatformClientFunctions {
  /**
   * Notify client of order status change
   */
  onOrderStatusChanged: (update: OrderStatusUpdate) => void;

  /**
   * Request client to refresh order list
   */
  refreshOrderList: () => void;

  /**
   * Request payment confirmation
   */
  confirmPayment: (amount: number) => boolean;
}
