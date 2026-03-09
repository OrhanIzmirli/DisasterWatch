FROM node:20-alpine

WORKDIR /app

# package dosyaları
COPY package*.json ./
RUN npm install

# Prisma schema
COPY prisma ./prisma

# 🔴 KRİTİK
RUN npx prisma generate

# source code
COPY . .

# 🔴 AZURE INGRESS İÇİN ŞART
EXPOSE 5000

# 🔴 DOĞRU ENTRYPOINT
CMD ["node", "src/index.js"]
