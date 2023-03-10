import { type Application } from "express";

export function healthcheck(server: Application): void {
  server.get("/health", (_, res) => {
    res.jsonp({});
  });
}
