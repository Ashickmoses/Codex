FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY . .
RUN npm run build
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","start"]
