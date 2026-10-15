FROM node:24.13.0-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
