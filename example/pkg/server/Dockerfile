FROM oven/bun:slim

WORKDIR /app

# Only copy the dist directory
COPY dist/ ./

# Expose the port
EXPOSE 8080

# Start the server
CMD ["bun", "index.js"] 