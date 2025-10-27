#!/bin/bash

# Build the application
echo "Building application..."
npm run build

# Deploy to Fly.io
echo "Deploying to Fly.io..."
fly deploy

echo "Deployment complete!" 