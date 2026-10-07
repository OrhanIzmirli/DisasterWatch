FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm install

# Prisma schema
COPY prisma ./prisma

# Generate the Prisma client at build time
RUN npx prisma generate

# Source code
COPY . .

# Default port (overridable with PORT)
EXPOSE 5000

# Start the API
CMD ["node", "src/index.js"]
