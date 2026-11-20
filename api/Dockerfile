FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js db.js repo.js schema.js migrate.js ./
ENV NODE_ENV=production
EXPOSE 3000
# node:sqlite is still flagged experimental in Node 22 and prints a warning on first use.
# It is stable for what this uses (prepared statements, transactions), and the warning on
# every container start is noise that hides real ones. --disable-warning silences that one
# warning class and nothing else.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
