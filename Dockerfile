FROM node:20-alpine
WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci || npm install

COPY src ./src
RUN npm run build

EXPOSE 3002

CMD ["npm", "run", "start"]
