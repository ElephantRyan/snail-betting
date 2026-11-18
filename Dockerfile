# 1) build the TypeScript front end
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) build the Go server, embedding the built front end
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY --from=web /web/dist ./web/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /snail-betting .

# 3) tiny runtime image
FROM scratch
COPY --from=server /snail-betting /snail-betting
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/snail-betting"]
