# Apify Actor Dockerfile
# Uses Apify's Node base image (includes tools needed for typical scraping workloads).
FROM apify/actor-node:20

# Copy package files first for better Docker layer caching.
COPY package.json package-lock.json* ./

# Install dependencies (omit dev deps for smaller image).
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source code.
COPY . ./

# Run the Actor.
CMD ["node", "main.js"]
