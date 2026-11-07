FROM node:24.13.0-alpine

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Prisma schema
COPY prisma ./prisma

# Generate the Prisma client at build time
RUN npx prisma generate

# Source code
COPY . .

# GeoNames population table for the exposure term of the priority score
# (CC BY 4.0; downloaded here, never committed; a failed download only makes
# exposure "unknown")
RUN node scripts/fetch-population.mjs

# Default port (overridable with PORT)
EXPOSE 5000

# Start the API
CMD ["node", "src/index.js"]
