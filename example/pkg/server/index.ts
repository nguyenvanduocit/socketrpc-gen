import { createServer } from "http";
import { Server } from "socket.io";

// must be added to the top of the file
// import '@shopify/shopify-api/adapters/node';
import type { ExtendedSocket } from "./type.d";
import { authMiddleware } from "./auth";
import { handleGenerateText, showError } from "@socket-rpc/rpc/server";
import type { RpcError } from "@socket-rpc/rpc";

// Constants
/** Server port configuration - defaults to 8080 if PORT environment variable is not set */
const PORT = process.env.PORT || 8080;

// Initialize HTTP server
/**
 * Creates the base HTTP server instance that will be used by Socket.IO
 * This server handles the underlying HTTP connections and upgrades to WebSocket
 */
const httpServer = createServer();

// Initialize Socket.IO server
/**
 * Socket.IO server configuration with CORS and transport settings
 *
 * Configuration details:
 * - CORS: Allows all origins for development (should be restricted in production)
 * - Transports: Supports both WebSocket and polling fallback
 * - pingTimeout: Client timeout after 60 seconds of inactivity
 * - pingInterval: Server sends ping every 30 seconds to keep connection alive
 */
const io = new Server(httpServer, {
  cors: {
    origin: "*", // TODO: Restrict to specific domains in production
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"], // WebSocket preferred, polling as fallback
  pingTimeout: 60000, // 60 seconds - time to wait for pong response
  pingInterval: 30000, // 30 seconds - interval between ping packets
});

// Apply authentication middleware
/**
 * Authentication middleware is applied to all incoming socket connections
 * This ensures only authenticated users can establish socket connections
 */
io.use(authMiddleware);

// Handle socket connections
/**
 * Main socket connection handler
 * Processes new client connections and sets up event handlers
 *
 * @param socket - Extended socket instance with authentication data
 */
io.on("connection", async (socket: ExtendedSocket) => {
  // Log successful client connection with user context
  console.log(`Client connected: ${socket.id} (User: ${socket.data.userId})`);

  /**
   * Handle client disconnection
   * Logs when a client disconnects for monitoring purposes
   */
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });

  /**
   * RPC handler for text generation functionality
   *
   * This demonstrates the RPC pattern where the client can call server methods
   * with automatic type inference and response handling
   *
   * @param prompt - Input text prompt from the client
   * @returns Promise<string> - Generated text response
   */
  handleGenerateText(
    socket,
    async (prompt: string): Promise<string | RpcError> => {
      if (prompt === "error") {
        return { message: "expected error" } as RpcError;
      } else if (prompt === "throw") {
        throw new Error("unexpected error");
      }
      return "test success";
    }
  );
});

/**
 * Start the HTTP server and begin listening for connections
 *
 * The server will accept both HTTP requests and WebSocket connections
 * on the specified port
 */
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
