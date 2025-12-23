import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server } from "socket.io";
import { readFileSync } from "fs"; // Added for getAppVersion
import { join } from "path"; // Added for getAppVersion

// must be added to the top of the file
// import '@shopify/shopify-api/adapters/node';
import type { ExtendedSocket } from "./type.d";
import { authMiddleware } from "./auth";
import { createRpcServer } from "@socket-rpc/rpc/server.generated";
import type { RpcError } from "@socket-rpc/rpc";

// === UTILITY FUNCTIONS ===
/**
 * Safe error logger that handles any type of error object
 * @param context - Context where the error occurred
 * @param error - The error to log
 */
function logError(context: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ❌ Error in ${context}:`, error);

  if (error instanceof Error) {
    console.error(`Stack trace:`, error.stack);
  }
}

/**
 * Get the application version from package.json
 * @returns Version string or fallback
 */
function getAppVersion(): string {
  try {
    // Assuming package.json is in the root of the 'server' package or one level up if 'pkg/server' is CWD
    // Adjust path if necessary. For this example, let's assume it's in the current working directory or one level up.
    let packagePath = join(process.cwd(), "package.json");
    try {
      readFileSync(packagePath, "utf-8");
    } catch (e) {
      // If not in cwd, try one level up (e.g. if script is run from example/pkg/server, package.json might be in example/pkg)
      packagePath = join(process.cwd(), "..", "package.json");
      // If still not found, try two levels up (e.g. example/package.json)
      try {
        readFileSync(packagePath, "utf-8");
      } catch (e2) {
        packagePath = join(process.cwd(), "..", "..", "package.json"); // For example/pkg/server -> example/package.json
      }
    }
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "1.0.0";
  } catch (error) {
    logError("getAppVersion", error);
    return "1.0.0"; // Fallback version
  }
}

// Constants
/** Server port configuration - defaults to 8080 if PORT environment variable is not set */
const PORT = process.env.PORT || 8080;

// Initialize HTTP server
/**
 * Creates the base HTTP server instance that will be used by Socket.IO
 * This server handles the underlying HTTP connections and upgrades to WebSocket.
 * Also provides a health check endpoint at /healthz.
 */
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/healthz" && req.method === "GET") {
    try {
      const isHealthy = !!io; // Basic check: Socket.IO server is initialized
      const statusCode = isHealthy ? 200 : 503;

      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });

      res.end(
        JSON.stringify({
          status: isHealthy ? "healthy" : "unhealthy",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version: getAppVersion(),
          environment: process.env.NODE_ENV || "development",
          services: {
            socket_io: !!io,
          },
        })
      );
    } catch (error) {
      logError("Health check endpoint", error);
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(
        JSON.stringify({
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          error: "Health check failed processing request",
        })
      );
    }
    return;
  }

  // For all other requests, respond with 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

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
let io: Server;
try {
  io = new Server(httpServer, {
    cors: {
      origin: "*", // TODO: Restrict to specific domains in production
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"], // WebSocket preferred, polling as fallback
    pingTimeout: 60000, // 60 seconds - time to wait for pong response
    pingInterval: 30000, // 30 seconds - interval between ping packets
  });
  console.log("✅ Socket.IO server initialized");
} catch (error) {
  logError("Socket.IO server initialization", error);
  process.exit(1);
}

// Apply authentication middleware
/**
 * Authentication middleware is applied to all incoming socket connections
 * This ensures only authenticated users can establish socket connections
 */
io.use(authMiddleware);

/**
 * Global Socket.IO engine error handler
 */
io.engine.on("connection_error", (err) => {
  logError("Socket.IO connection_error", {
    code: err.code,
    message: err.message,
    // @ts-ignore
    context: err.context,
  });
});

// Handle socket connections
/**
 * Main socket connection handler
 * Processes new client connections and sets up event handlers
 *
 * @param socket - Extended socket instance with authentication data
 */
io.on("connection", async (socket: ExtendedSocket) => {
  try {
    // Log successful client connection with user context
    console.log(`Client connected: ${socket.id} (User: ${socket.data.userId})`);

    // Create RPC server instance with new ergonomic API
    const rpc = createRpcServer(socket);

    /**
     * Handle client disconnection
     * Logs when a client disconnects and cleans up RPC handlers
     */
    socket.on("disconnect", (reason) => {
      console.log(`Client disconnected: ${socket.id} (Reason: ${reason})`);
      rpc.dispose(); // Clean up RPC handlers
    });

    /**
     * Global error handler for this specific socket instance
     */
    socket.on("error", (error) => {
      logError(`Socket error (ID: ${socket.id})`, error);
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
    rpc.handle.generateText(async (prompt): Promise<string | RpcError> => {
      try {
        if (prompt === "error") {
          return { message: "expected error" } as RpcError;
        } else if (prompt === "throw") {
          throw new Error("unexpected error");
        }
        return "test success";
      } catch (rpcError) {
        logError(
          `RPC generateText (Socket: ${socket.id}, User: ${socket.data.userId})`,
          rpcError
        );
        // Notify the client about the error via rpc.client.showError
        rpc.client.showError(
          new Error("An unexpected error occurred processing your request.")
        );
        return {
          message: "Internal server error during text generation.",
        } as RpcError;
      }
    });
  } catch (connectionError) {
    logError(
      `Socket connection event handler (Socket: ${socket.id})`,
      connectionError
    );
    // Try to notify the client about the connection error if the socket is still valid
    try {
      socket.emit("error", {
        message: "Connection setup failed due to server error.",
      });
    } catch (emitError) {
      logError(
        `Socket error emission during connection_error (Socket: ${socket.id})`,
        emitError
      );
    }
  }
});

// === GLOBAL PROCESS ERROR HANDLERS ===
/**
 * Graceful shutdown handler for SIGTERM
 * Handles SIGTERM signals for clean shutdown
 */
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  io.close(() => {
    // Close Socket.IO connections
    console.log("✅ Socket.IO server closed");
    httpServer.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });

  // Force shutdown if not closed within a timeout
  setTimeout(() => {
    logError(
      "Graceful shutdown timeout",
      new Error("Forcing exit after SIGTERM timeout")
    );
    process.exit(1);
  }, 10000); // 10 seconds timeout
});

/**
 * Graceful shutdown handler for SIGINT
 * Handles SIGINT signals (e.g., Ctrl+C) for clean shutdown
 */
process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  io.close(() => {
    // Close Socket.IO connections
    console.log("✅ Socket.IO server closed");
    httpServer.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });

  // Force shutdown if not closed within a timeout
  setTimeout(() => {
    logError(
      "Graceful shutdown timeout",
      new Error("Forcing exit after SIGINT timeout")
    );
    process.exit(1);
  }, 10000); // 10 seconds timeout
});

/**
 * Start the HTTP server and begin listening for connections
 *
 * The server will accept both HTTP requests and WebSocket connections
 * on the specified port
 */
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
});

/**
 * Handle HTTP server errors (e.g., port in use)
 */
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  logError("HTTP server error", error);
  if (error.code === "EADDRINUSE") {
    console.error(`❌ Address http://localhost:${PORT} is already in use.`);
  } else if (error.code === "EACCES") {
    console.error(
      `❌ Permission denied to use port ${PORT}. Try running with sudo or using a different port.`
    );
  }
  process.exit(1);
});
